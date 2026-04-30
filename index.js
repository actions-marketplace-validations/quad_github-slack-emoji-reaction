import fs from "node:fs";

const SLACK_API = "https://slack.com/api/";

const STATUS_APPROVED = "approved";
const STATUS_CHANGES_REQUESTED = "changes-requested";
const STATUS_MERGED = "merged";
const STATUS_CLOSED = "closed";

const FLIP_OPPOSITE = {
	[STATUS_APPROVED]: STATUS_CHANGES_REQUESTED,
	[STATUS_CHANGES_REQUESTED]: STATUS_APPROVED,
};

const TOLERATED_REACTION_ERRORS = new Set([
	"already_reacted",
	"no_reaction",
	"not_in_channel",
	"channel_not_found",
	"message_not_found",
]);
const STALE_MATCH_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"message_not_found",
]);
const AUTH_ERRORS = new Set([
	"invalid_auth",
	"token_revoked",
	"account_inactive",
	"not_authed",
]);

const BOT_USER_ID_TTL_S = 30 * 24 * 3600;
const CHANNEL_LIST_TTL_S = 24 * 3600;
const PR_STALE_TTL_S = 90 * 24 * 3600;
const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
const REACTIONS_PER_RUN_CAP = 50;
const MAX_PR_ENTRIES = 10000;
const SLACK_PACE_MS = 1200;
const RETRY_AFTER_CAP_S = 60;
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
const input = (name) =>
	(process.env[`INPUT_${name.toUpperCase()}`] || "").trim();

const keepsMatch = (result) => !STALE_MATCH_ERRORS.has(result.error);

export function tokenizeAngles(text) {
	const out = [];
	let i = 0;
	while (i < text.length) {
		const lt = text.indexOf("<", i);
		if (lt < 0) break;
		const gt = text.indexOf(">", lt + 1);
		if (gt < 0) break;
		let cand = text.slice(lt + 1, gt);
		const pipe = cand.indexOf("|");
		if (pipe >= 0) cand = cand.slice(0, pipe);
		out.push(cand);
		i = gt + 1;
	}
	return out;
}

function walkForUrls(node) {
	if (!node || typeof node !== "object") return [];
	const here = typeof node.url === "string" ? [node.url] : [];
	return here.concat(...Object.values(node).map(walkForUrls));
}

export function urlsFromMessage(message) {
	const fromText =
		typeof message.text === "string" ? tokenizeAngles(message.text) : [];
	const fromAttachments = (message.attachments || []).flatMap((a) =>
		[a.title_link, a.from_url].filter((s) => typeof s === "string"),
	);
	const fromBlocks = (message.blocks || []).flatMap(walkForUrls);
	return [...fromText, ...fromAttachments, ...fromBlocks];
}

// `:num` only consumes up to the next `/`, so /pull/123 matches and
// /pull/1234 / /pull/123/files don't — the substring trap closed at the parser.
const PR_URL = new URLPattern({
	protocol: "https",
	hostname: "github.com",
	pathname: "/:owner/:repo/pull/:num",
});

export function matchesPullUrl(pr, candidate) {
	const g = PR_URL.exec(candidate)?.pathname.groups;
	return (
		!!g &&
		g.owner === pr.owner &&
		g.repo === pr.repo &&
		g.num === String(pr.num)
	);
}

export function deriveStatus(eventName, payload) {
	if (eventName === "pull_request_review") {
		if (payload.action !== "submitted") return null;
		const state = payload.review?.state;
		if (state === "approved") return STATUS_APPROVED;
		if (state === "changes_requested") return STATUS_CHANGES_REQUESTED;
		return null;
	}
	if (eventName === "pull_request") {
		if (payload.action !== "closed") return null;
		return payload.pull_request?.merged ? STATUS_MERGED : STATUS_CLOSED;
	}
	return null;
}

export function prContext(payload) {
	const pr = payload.pull_request;
	const owner = pr?.base?.repo?.owner?.login;
	const repo = pr?.base?.repo?.name;
	const num = pr?.number;
	if (!owner || !repo || !Number.isFinite(num)) return null;
	return { owner, repo, num, prUrl: pr.html_url };
}

// Thrown for any condition that should fail the workflow with an
// operator-facing message but no stack trace. The entrypoint catches
// and prints the message; everything else propagates to Node's default
// unhandled-rejection handler (stack + non-zero exit).
export class FatalError extends Error {}

export class AuthError extends FatalError {
	constructor(code) {
		super(`Slack auth error: ${code}. Refresh the SLACK_TOKEN secret.`);
		this.code = code;
	}
}

export class SlackClient {
	#token;
	#fetch;
	#apiBase;
	#paceMs;
	#maxRetries;
	#retryAfterCapS;
	#lastCallAt = 0;

	constructor({
		token,
		fetch = globalThis.fetch,
		apiBase = SLACK_API,
		paceMs = SLACK_PACE_MS,
		maxRetries = MAX_RETRIES,
		retryAfterCapS = RETRY_AFTER_CAP_S,
	} = {}) {
		this.#token = token;
		this.#fetch = fetch;
		this.#apiBase = apiBase;
		this.#paceMs = paceMs;
		this.#maxRetries = maxRetries;
		this.#retryAfterCapS = retryAfterCapS;
	}

	async call(method, params) {
		const url = this.#apiBase + method;
		let lastBody;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			const wait = this.#paceMs - (Date.now() - this.#lastCallAt);
			if (wait > 0) await sleep(wait);
			this.#lastCallAt = Date.now();

			let res;
			try {
				res = await this.#fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.#token}`,
						"Content-Type": "application/json; charset=utf-8",
					},
					body: JSON.stringify(params || {}),
				});
				lastBody = await res.json();
			} catch (e) {
				console.warn(
					`slack ${method} network error: ${e.message} (attempt ${attempt + 1}/${this.#maxRetries + 1})`,
				);
				if (attempt >= this.#maxRetries)
					return { ok: false, error: "network_error" };
				await sleep(1000);
				continue;
			}

			// Slack reports rate limiting two ways: 429 with Retry-After, and
			// HTTP 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
			const isRateLimited =
				res.status === 429 ||
				(lastBody?.ok === false && lastBody.error === "ratelimited");
			if (!isRateLimited) {
				if (lastBody?.ok === false && AUTH_ERRORS.has(lastBody.error)) {
					throw new AuthError(lastBody.error);
				}
				return lastBody;
			}

			const retry = Math.min(
				parseInt(res.headers.get("retry-after"), 10) || 1,
				this.#retryAfterCapS,
			);
			console.warn(
				`slack ${method} ratelimited; retry-after ${retry}s (attempt ${attempt + 1}/${this.#maxRetries + 1})`,
			);
			if (attempt >= this.#maxRetries) break;
			await sleep(retry * 1000);
		}
		return lastBody;
	}
}

export class CacheClient {
	#base;
	#token;
	#fetch;
	#headers;
	#enabled;
	#keyPrefix;
	#version;
	#runKey;

	constructor({
		env = process.env,
		fetch = globalThis.fetch,
		keyPrefix = "slack-emoji-reactions-state-",
		version = "slack-emoji-reactions-v1",
	} = {}) {
		const rawBase = env.ACTIONS_CACHE_URL || "";
		this.#base = rawBase.endsWith("/") ? rawBase : rawBase ? `${rawBase}/` : "";
		this.#token = env.ACTIONS_RUNTIME_TOKEN || "";
		this.#fetch = fetch;
		this.#headers = {
			Authorization: `Bearer ${this.#token}`,
			Accept: "application/json;api-version=6.0-preview.1",
		};
		this.#enabled = !!this.#base && !!this.#token;
		this.#keyPrefix = keyPrefix;
		this.#version = version;
		this.#runKey = `${env.GITHUB_RUN_ID || "norunid"}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
	}

	#url(path) {
		return new URL(`_apis/artifactcache/${path}`, this.#base);
	}

	#send(path, init = {}) {
		return this.#fetch(this.#url(path), {
			...init,
			headers: { ...this.#headers, ...(init.headers || {}) },
		});
	}

	async restore() {
		if (!this.#enabled) return null;
		try {
			const lookup = this.#url("cache");
			// Sentinel primary key never matches; the second key is a prefix lookup
			// against every entry we've saved, returning the most recent one.
			lookup.searchParams.set(
				"keys",
				`${this.#keyPrefix}__sentinel__,${this.#keyPrefix}`,
			);
			lookup.searchParams.set("version", this.#version);
			const res = await this.#fetch(lookup, { headers: this.#headers });
			if (res.status === 204) return null;
			if (!res.ok) {
				console.warn(`cache restore lookup status ${res.status}`);
				return null;
			}
			const meta = await res.json();
			if (!meta?.archiveLocation) return null;
			const blob = await this.#fetch(meta.archiveLocation);
			if (!blob.ok) {
				console.warn(`cache blob fetch status ${blob.status}`);
				return null;
			}
			return await blob.json();
		} catch (e) {
			console.warn(`cache restore failed: ${e.message}`);
			return null;
		}
	}

	async save(state) {
		if (!this.#enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");

			const reserveRes = await this.#send("caches", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: `${this.#keyPrefix}${this.#runKey}`,
					version: this.#version,
					cacheSize: body.length,
				}),
			});
			if (!reserveRes.ok) {
				console.warn(`cache reserve status ${reserveRes.status}`);
				return;
			}
			const cacheId = (await reserveRes.json())?.cacheId;
			if (!cacheId) return;

			const uploadRes = await this.#send(`caches/${cacheId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Range": `bytes 0-${body.length - 1}/*`,
				},
				body,
			});
			if (!uploadRes.ok) {
				console.warn(`cache upload status ${uploadRes.status}`);
				return;
			}

			const commitRes = await this.#send(`caches/${cacheId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ size: body.length }),
			});
			if (!commitRes.ok) {
				console.warn(`cache commit status ${commitRes.status}`);
			}
		} catch (e) {
			console.warn(`cache save failed: ${e.message}`);
		}
	}
}

// Keyed map of { value, refreshedAt } cells. Plain reads/writes plus
// TTL-aware memoization (ensure), stale-sweep, and LRU cap.
export class Memo {
	#cells;

	constructor(cells = {}) {
		this.#cells = cells;
	}

	get(key) {
		return this.#cells[key]?.value;
	}

	set(key, value) {
		this.#cells[key] = { value, refreshedAt: nowS() };
	}

	delete(key) {
		delete this.#cells[key];
	}

	// Returns the cached value if its age is under `ttlS`; otherwise runs
	// `fetcher`, writes the result back, and returns it.
	async ensure(key, ttlS, fetcher) {
		const cell = this.#cells[key];
		if (cell && nowS() - cell.refreshedAt < ttlS) return cell.value;
		const value = await fetcher();
		this.set(key, value);
		return value;
	}

	// Evict entries last refreshed before `cutoffS`. Returns count removed.
	sweepStale(cutoffS) {
		const before = Object.keys(this.#cells).length;
		this.#cells = Object.fromEntries(
			Object.entries(this.#cells).filter(([, v]) => v.refreshedAt >= cutoffS),
		);
		return before - Object.keys(this.#cells).length;
	}

	// Keep the most-recently-refreshed `max` entries. Returns count evicted.
	capByLru(max) {
		const keys = Object.keys(this.#cells);
		if (keys.length <= max) return 0;
		keys.sort(
			(a, b) => this.#cells[a].refreshedAt - this.#cells[b].refreshedAt,
		);
		const evict = keys.slice(0, keys.length - max);
		for (const k of evict) delete this.#cells[k];
		return evict.length;
	}

	toJSON() {
		return this.#cells;
	}
}

// Fetchers paired with their memo keys + TTLs. The functions here are the
// concrete I/O; ActionState.memo decides whether to invoke them.
export async function fetchBotUserId(slack) {
	const res = await slack.call("auth.test", {});
	if (!res.ok) throw new Error(`auth.test failed: ${res.error}`);
	return res.user_id;
}

// Yields successive Slack pages, threading cursor through. Consumers
// drive termination: drain to completion, cap page count, break on hit,
// throw on error — all just standard for-await control flow.
async function* paginate(slack, method, baseParams) {
	let cursor = "";
	while (true) {
		const params = { ...baseParams };
		if (cursor) params.cursor = cursor;
		const res = await slack.call(method, params);
		yield res;
		if (!res.ok) return;
		cursor = res.response_metadata?.next_cursor || "";
		if (!cursor) return;
	}
}

export async function fetchChannels(slack) {
	const out = [];
	for await (const res of paginate(slack, "conversations.list", {
		types: "public_channel,private_channel",
		exclude_archived: true,
		limit: 200,
	})) {
		if (!res.ok) throw new Error(`conversations.list failed: ${res.error}`);
		for (const c of res.channels) {
			if (c.is_member) out.push({ id: c.id, name: c.name });
		}
	}
	return out;
}

export async function discoverMatches(slack, pr, channels) {
	if (channels.length > MAX_CHANNELS_PER_RUN) {
		console.warn(
			`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; skipped ${channels.length - MAX_CHANNELS_PER_RUN} remaining`,
		);
	}
	const matches = [];
	const oldest = String(nowS() - HISTORY_LOOKBACK_S);
	for (const ch of channels.slice(0, MAX_CHANNELS_PER_RUN)) {
		let page = 0;
		for await (const res of paginate(slack, "conversations.history", {
			channel: ch.id,
			oldest,
			limit: 200,
		})) {
			if (!res.ok) {
				console.warn(
					`conversations.history ${ch.id}(${ch.name}): ${res.error}`,
				);
				break;
			}
			const hit = res.messages.find((msg) =>
				urlsFromMessage(msg).some((c) => matchesPullUrl(pr, c)),
			);
			if (hit) {
				matches.push({ channel: ch.id, ts: hit.ts });
				break;
			}
			if (++page >= HISTORY_PAGES_PER_CHANNEL) break;
		}
	}
	return matches;
}

// approved↔changes-requested is the only flippable pair. Remove the
// opposite emoji only if our own bot put it there. Skipped on re-runs
// so a stale replay can't reverse a real later state.
async function flipCleanup(ctx, match) {
	const { removeEmoji, botUserId, isRerun, slack } = ctx;
	if (isRerun || !removeEmoji) return;

	const where = `${match.channel}/${match.ts}`;
	const got = await slack.call("reactions.get", {
		channel: match.channel,
		timestamp: match.ts,
		full: true,
	});
	if (!got.ok) {
		if (!TOLERATED_REACTION_ERRORS.has(got.error)) {
			console.warn(`reactions.get ${where}: ${got.error}`);
		}
		return;
	}
	const opp = got.message?.reactions?.find((r) => r.name === removeEmoji);
	if (!opp?.users.includes(botUserId)) return;

	const rm = await slack.call("reactions.remove", {
		channel: match.channel,
		timestamp: match.ts,
		name: removeEmoji,
	});
	if (!rm.ok && !TOLERATED_REACTION_ERRORS.has(rm.error)) {
		console.warn(`reactions.remove ${where} ${removeEmoji}: ${rm.error}`);
	}
}

export async function reactToMatch(ctx, match) {
	const { addEmoji, slack } = ctx;
	const where = `${match.channel}/${match.ts}`;

	await flipCleanup(ctx, match);

	const add = await slack.call("reactions.add", {
		channel: match.channel,
		timestamp: match.ts,
		name: addEmoji,
	});
	if (!add.ok && !TOLERATED_REACTION_ERRORS.has(add.error)) {
		console.warn(`reactions.add ${where} ${addEmoji}: ${add.error}`);
	}
	return { ok: !!add.ok, error: add.error };
}

// Read env + payload into a job spec. Throws FatalError on operator-fixable
// problems; returns null on routine skips (unmapped event, unconfigured
// emoji, fork PR with no secrets); otherwise returns the job to run.
function readJob() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath)
		throw new FatalError(
			"GITHUB_EVENT_PATH not set; not running inside GitHub Actions",
		);
	const eventName = process.env.GITHUB_EVENT_NAME;
	if (!eventName)
		throw new FatalError(
			"GITHUB_EVENT_NAME not set; not running inside GitHub Actions",
		);
	const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

	const status = deriveStatus(eventName, payload);
	if (!status) return null;
	const addEmoji = input(`emoji-${status}`);
	if (!addEmoji) return null;

	const token = input("slack-token");
	if (!token) {
		// Fork PRs run with empty secrets by design — that's not a misconfig.
		if (payload.pull_request?.head?.repo?.fork) return null;
		throw new FatalError("slack-token is missing; set the SLACK_TOKEN secret");
	}

	const pr = prContext(payload);
	if (!pr) throw new FatalError("could not derive PR context from payload");

	const opposite = FLIP_OPPOSITE[status];
	return {
		status,
		token,
		addEmoji,
		removeEmoji: opposite ? input(`emoji-${opposite}`) : "",
		isRerun: parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) > 1,
		pr,
		prKey: `${pr.owner}/${pr.repo}#${pr.num}`,
	};
}

async function findMatches(slack, memo, prMatches, job) {
	const cached = prMatches.get(job.prKey);
	if (cached?.length) return cached;
	const channels = await memo.ensure("channels", CHANNEL_LIST_TTL_S, () =>
		fetchChannels(slack),
	);
	return discoverMatches(slack, job.pr, channels);
}

// React to as many matches as the per-run cap allows, keeping prMatches
// in sync per iteration so a mid-loop throw doesn't lose discovered work
// or leave a terminal PR's entry stranded.
async function applyReactions(slack, memo, prMatches, job, matches) {
	const isTerminal =
		job.status === STATUS_MERGED || job.status === STATUS_CLOSED;
	const needsFlipCleanup = job.removeEmoji && !job.isRerun && matches.length;
	const ctx = {
		addEmoji: job.addEmoji,
		removeEmoji: job.removeEmoji,
		isRerun: job.isRerun,
		slack,
		botUserId: needsFlipCleanup
			? await memo.ensure("botUserId", BOT_USER_ID_TTL_S, () =>
					fetchBotUserId(slack),
				)
			: null,
	};

	const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);
	const overflow = matches.slice(REACTIONS_PER_RUN_CAP);
	if (overflow.length) {
		console.warn(
			`reactions-per-run cap (${REACTIONS_PER_RUN_CAP}) reached; ${overflow.length} kept in cache for next run`,
		);
	}

	// Persist the full set up-front so an early throw still leaves the
	// discovered matches in cache for the next run to retry.
	let alive = [...toReact, ...overflow];
	prMatches.set(job.prKey, alive);

	for (const m of toReact) {
		const result = await reactToMatch(ctx, m);
		if (!keepsMatch(result)) {
			alive = alive.filter((x) => x !== m);
			prMatches.set(job.prKey, alive);
		}
	}

	// Clean completion: terminal events drop the entry entirely; non-terminal
	// runs that left nothing alive also drop (next event re-discovers).
	if (isTerminal || !alive.length) prMatches.delete(job.prKey);
}

async function main() {
	const job = readJob();
	if (!job) return;
	console.log(`::add-mask::${job.token}`);

	const slack = new SlackClient({ token: job.token });
	const cache = new CacheClient();
	const restored = (await cache.restore()) ?? {};
	const memo = new Memo(restored.memo);
	const prMatches = new Memo(restored.prMatches);

	// All mutations on memo/prMatches are individually valid (sweepStale,
	// ensure, set, delete, capByLru each leave the structure consistent),
	// so persisting in `finally` always writes a valid snapshot — partial
	// progress (memoized I/O, surviving matches) is never lost to a throw.
	try {
		prMatches.sweepStale(nowS() - PR_STALE_TTL_S);
		const matches = await findMatches(slack, memo, prMatches, job);
		await applyReactions(slack, memo, prMatches, job, matches);
	} finally {
		const evicted = prMatches.capByLru(MAX_PR_ENTRIES);
		if (evicted) console.warn(`pr-entries safety cap; evicted ${evicted}`);
		await cache.save({ memo, prMatches });
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (e) {
		if (!(e instanceof FatalError)) throw e;
		console.error(e.message);
		process.exit(1);
	}
}
