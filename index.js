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

const CHANNEL_LIST_TTL_S = 24 * 3600;
const PR_STALE_TTL_S = 90 * 24 * 3600;
const MAX_PR_ENTRIES = 10000;
const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
const REACTIONS_PER_RUN_CAP = 50;
const SLACK_PACE_MS = 1200;
const RETRY_AFTER_CAP_S = 60;
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] || "";

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

function checkAuth(res) {
	if (res?.ok === false && AUTH_ERRORS.has(res.error)) {
		throw new AuthError(res.error);
	}
}

export class SlackClient {
	#token;
	#fetch;
	#paceMs;
	#lastCallAt = 0;

	constructor({
		token,
		fetch = globalThis.fetch,
		paceMs = SLACK_PACE_MS,
	} = {}) {
		this.#token = token;
		this.#fetch = fetch;
		this.#paceMs = paceMs;
	}

	async call(method, params) {
		const url = SLACK_API + method;
		let lastBody;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
					`slack ${method} network error: ${e.message} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
				);
				if (attempt >= MAX_RETRIES)
					return { ok: false, error: "network_error" };
				await sleep(1000);
				continue;
			}

			// Slack reports rate limiting two ways: 429 with Retry-After, and
			// HTTP 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
			const isRateLimited =
				res.status === 429 ||
				(lastBody?.ok === false && lastBody.error === "ratelimited");
			if (!isRateLimited) return lastBody;

			const retry = Math.min(
				parseInt(res.headers.get("retry-after"), 10) || 1,
				RETRY_AFTER_CAP_S,
			);
			console.warn(
				`slack ${method} ratelimited; retry-after ${retry}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
			);
			if (attempt >= MAX_RETRIES) break;
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

	async save(state, suffix) {
		if (!this.#enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");

			const reserveRes = await this.#send("caches", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: `${this.#keyPrefix}${suffix}`,
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

// Per-PR cache map: { "owner/repo#num" → { matches, lastTouched } }.
// Encapsulates the lifecycle (read/write/delete + stale-sweep + LRU cap)
// so callers don't reach into the entries' shape directly.
export class PrMatches {
	#entries;

	constructor(entries = {}) {
		this.#entries = entries;
	}

	get(key) {
		return this.#entries[key]?.matches;
	}

	set(key, matches) {
		this.#entries[key] = { matches, lastTouched: nowS() };
	}

	delete(key) {
		delete this.#entries[key];
	}

	// Evict entries last touched before `cutoffS`. Returns count removed.
	sweepStale(cutoffS) {
		const before = Object.keys(this.#entries).length;
		this.#entries = Object.fromEntries(
			Object.entries(this.#entries).filter(([, v]) => v.lastTouched >= cutoffS),
		);
		return before - Object.keys(this.#entries).length;
	}

	// Keep the `max` most-recently-touched entries. Returns count evicted.
	capByLru(max) {
		const keys = Object.keys(this.#entries);
		if (keys.length <= max) return 0;
		keys.sort(
			(a, b) => this.#entries[a].lastTouched - this.#entries[b].lastTouched,
		);
		const evict = keys.slice(0, keys.length - max);
		for (const k of evict) delete this.#entries[k];
		return evict.length;
	}

	toJSON() {
		return this.#entries;
	}
}

export async function ensureBotUserId(state, slack) {
	if (state.botUserId) return state.botUserId;
	const res = await slack.call("auth.test", {});
	checkAuth(res);
	if (!res.ok) throw new Error(`auth.test failed: ${res.error}`);
	state.botUserId = res.user_id;
	return state.botUserId;
}

export async function ensureChannels(state, slack) {
	const fresh =
		state.channels &&
		state.channelsRefreshedAt &&
		nowS() - state.channelsRefreshedAt < CHANNEL_LIST_TTL_S;
	if (fresh) return state.channels;

	const channels = [];
	let cursor = "";
	while (true) {
		const params = {
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: 200,
		};
		if (cursor) params.cursor = cursor;
		const res = await slack.call("conversations.list", params);
		checkAuth(res);
		if (!res.ok) throw new Error(`conversations.list failed: ${res.error}`);
		for (const c of res.channels) {
			if (c.is_member) channels.push({ id: c.id, name: c.name });
		}
		cursor = res.response_metadata?.next_cursor || "";
		if (!cursor) break;
	}
	state.channels = channels;
	state.channelsRefreshedAt = nowS();
	return channels;
}

export async function discoverMatches(channels, pr, slack) {
	const matches = [];
	const oldest = String(nowS() - HISTORY_LOOKBACK_S);
	let scanned = 0;
	for (const ch of channels) {
		if (scanned >= MAX_CHANNELS_PER_RUN) {
			console.warn(
				`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; skipped ${channels.length - scanned} remaining`,
			);
			break;
		}
		scanned++;
		let cursor = "";
		let foundInChannel = false;
		for (
			let page = 0;
			page < HISTORY_PAGES_PER_CHANNEL && !foundInChannel;
			page++
		) {
			const params = { channel: ch.id, oldest, limit: 200 };
			if (cursor) params.cursor = cursor;
			const res = await slack.call("conversations.history", params);
			checkAuth(res);
			if (!res.ok) {
				console.warn(
					`conversations.history ${ch.id}(${ch.name}): ${res.error}`,
				);
				break;
			}
			for (const msg of res.messages) {
				if (urlsFromMessage(msg).some((c) => matchesPullUrl(pr, c))) {
					matches.push({ channel: ch.id, ts: msg.ts });
					foundInChannel = true;
					break;
				}
			}
			cursor = res.response_metadata?.next_cursor || "";
			if (!cursor || !res.has_more) break;
		}
	}
	return matches;
}

export async function reactToMatch(ctx, match) {
	const { addEmoji, removeEmoji, botUserId, isRerun, slack } = ctx;
	const where = `${match.channel}/${match.ts}`;

	// approved↔changes-requested is the only flippable pair. Remove the
	// opposite emoji only if our own bot put it there. Skipped on re-runs
	// so a stale replay can't reverse a real later state.
	if (!isRerun && removeEmoji) {
		const got = await slack.call("reactions.get", {
			channel: match.channel,
			timestamp: match.ts,
			full: true,
		});
		checkAuth(got);
		if (got.ok) {
			const opp = got.message?.reactions?.find((r) => r.name === removeEmoji);
			if (opp?.users.includes(botUserId)) {
				const rm = await slack.call("reactions.remove", {
					channel: match.channel,
					timestamp: match.ts,
					name: removeEmoji,
				});
				checkAuth(rm);
				if (!rm.ok && !TOLERATED_REACTION_ERRORS.has(rm.error)) {
					console.warn(`reactions.remove ${where} ${removeEmoji}: ${rm.error}`);
				}
			}
		} else if (!TOLERATED_REACTION_ERRORS.has(got.error)) {
			console.warn(`reactions.get ${where}: ${got.error}`);
		}
	}

	const add = await slack.call("reactions.add", {
		channel: match.channel,
		timestamp: match.ts,
		name: addEmoji,
	});
	checkAuth(add);
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
	const addEmoji = input(`emoji-${status}`).trim();
	if (!addEmoji) return null;

	const token = input("slack-token").trim();
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
		removeEmoji: opposite ? input(`emoji-${opposite}`).trim() : "",
		isRerun: parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) > 1,
		pr,
		prKey: `${pr.owner}/${pr.repo}#${pr.num}`,
	};
}

async function findMatches(prMatches, job, state, slack) {
	const cached = prMatches.get(job.prKey);
	if (cached?.length) return cached;
	await ensureBotUserId(state, slack);
	const channels = await ensureChannels(state, slack);
	return discoverMatches(channels, job.pr, slack);
}

// React to as many matches as the per-run cap allows; carry the rest over
// in the cache so the next event for this PR picks them up.
async function applyReactions(matches, job, state, slack) {
	const ctx = {
		addEmoji: job.addEmoji,
		removeEmoji: job.removeEmoji,
		botUserId: state.botUserId,
		isRerun: job.isRerun,
		slack,
	};
	if (job.removeEmoji && !job.isRerun && matches.length && !ctx.botUserId) {
		ctx.botUserId = await ensureBotUserId(state, slack);
	}

	const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);
	const overflow = matches.slice(REACTIONS_PER_RUN_CAP);
	if (overflow.length) {
		console.warn(
			`reactions-per-run cap (${REACTIONS_PER_RUN_CAP}) reached; ${overflow.length} kept in cache for next run`,
		);
	}

	const reacted = [];
	for (const m of toReact) reacted.push([m, await reactToMatch(ctx, m)]);
	return [
		...reacted.filter(([, r]) => keepsMatch(r)).map(([m]) => m),
		...overflow,
	];
}

// Terminal events delete the entry; otherwise rewrite (bumping lastTouched
// so active PRs don't age out of the 90-day stale sweep).
function finalizeMatches(prMatches, job, survivors) {
	const isTerminal =
		job.status === STATUS_MERGED || job.status === STATUS_CLOSED;
	if (isTerminal || !survivors.length) prMatches.delete(job.prKey);
	else prMatches.set(job.prKey, survivors);

	const evicted = prMatches.capByLru(MAX_PR_ENTRIES);
	if (evicted) console.warn(`pr-entries safety cap; evicted ${evicted}`);
}

async function main() {
	const job = readJob();
	if (!job) return;
	console.log(`::add-mask::${job.token}`);

	const slack = new SlackClient({ token: job.token });
	const cache = new CacheClient();
	const state = (await cache.restore()) ?? {};
	const prMatches = new PrMatches(state.prMatches);
	prMatches.sweepStale(nowS() - PR_STALE_TTL_S);

	const matches = await findMatches(prMatches, job, state, slack);
	const survivors = await applyReactions(matches, job, state, slack);
	finalizeMatches(prMatches, job, survivors);

	state.prMatches = prMatches.toJSON();
	const runId = process.env.GITHUB_RUN_ID || "norunid";
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
	await cache.save(state, `${runId}-${runAttempt}`);
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
