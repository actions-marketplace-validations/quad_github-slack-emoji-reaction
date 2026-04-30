import fs from "node:fs";

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

function linksToPR(message, pr) {
	const target = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.num}`;
	// JSON.stringify flattens every Slack message shape (text <url>,
	// attachments, blocks) into a string the URL survives literally; \b
	// closes the /pull/12 vs /pull/123 substring trap.
	return new RegExp(`${RegExp.escape(target)}\\b`).test(
		JSON.stringify(message),
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
	return { owner, repo, num };
}

// Operator-fixable failures: top-level catch prints the message and exits 1
// without a stack. Anything else propagates as an unhandled rejection.
export class FatalError extends Error {
	static notNull(value, message) {
		if (!value) throw new FatalError(message);
		return value;
	}
}

export class SlackClient {
	static #SLACK_API = "https://slack.com/api/";
	static #AUTH_ERRORS = new Set([
		"invalid_auth",
		"token_revoked",
		"account_inactive",
		"not_authed",
	]);

	#token;
	#fetch;
	#apiBase;
	#paceMs;
	#maxRetries;
	#retryAfterCapS;
	#nextCallAt = 0;

	constructor({
		token,
		fetch = globalThis.fetch,
		apiBase = SlackClient.#SLACK_API,
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

	async #pace() {
		const wait = this.#nextCallAt - Date.now();
		if (wait > 0) await sleep(wait);
		this.#nextCallAt = Date.now() + this.#paceMs;
	}

	// Outcome:
	//   { kind: "ok", body }                       — return body
	//   { kind: "ratelimited", waitMs, body }      — sleep waitMs, retry
	//   { kind: "network", waitMs, body }          — sleep waitMs, retry
	// `body` carries what we'd surface if retries are exhausted.
	async #callOnce(method, params) {
		let res;
		try {
			res = await this.#fetch(this.#apiBase + method, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(params || {}),
			});
		} catch (e) {
			return {
				kind: "network",
				waitMs: 1000,
				body: { ok: false, error: "network_error", message: e.message },
			};
		}
		const body = await res.json();
		// Slack reports rate limiting two ways: 429 with Retry-After, and
		// HTTP 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
		const rateLimited =
			res.status === 429 ||
			(body?.ok === false && body.error === "ratelimited");
		if (rateLimited) {
			const secs = Math.min(
				Number(res.headers.get("retry-after")) || 1,
				this.#retryAfterCapS,
			);
			return { kind: "ratelimited", waitMs: secs * 1000, body };
		}
		if (body?.ok === false && SlackClient.#AUTH_ERRORS.has(body.error)) {
			throw new FatalError(
				`Slack auth error: ${body.error}. Refresh the SLACK_TOKEN secret.`,
			);
		}
		return { kind: "ok", body };
	}

	async call(method, params) {
		let outcome;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			await this.#pace();
			outcome = await this.#callOnce(method, params);
			if (outcome.kind === "ok") return outcome.body;
			const tag = `slack ${method} ${outcome.kind}`;
			const where = `(attempt ${attempt + 1}/${this.#maxRetries + 1})`;
			console.warn(
				outcome.kind === "network"
					? `${tag}: ${outcome.body.message} ${where}`
					: `${tag}; retry-after ${outcome.waitMs / 1000}s ${where}`,
			);
			if (attempt >= this.#maxRetries) break;
			await sleep(outcome.waitMs);
		}
		return outcome.body;
	}

	// Yields successive Slack pages, threading cursor through. Caps at
	// `maxPages` if given; otherwise drains to completion. Stops on
	// non-ok response or empty next_cursor.
	async *paginate(method, baseParams, { maxPages = Infinity } = {}) {
		let cursor = "";
		for (let page = 0; page < maxPages; page++) {
			const params = { ...baseParams };
			if (cursor) params.cursor = cursor;
			const res = await this.call(method, params);
			yield res;
			if (!res.ok) return;
			cursor = res.response_metadata?.next_cursor || "";
			if (!cursor) return;
		}
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

	// Eviction strategy: drop entries last refreshed before `cutoffS`.
	evictOlderThan(cutoffS) {
		this.#cells = Object.fromEntries(
			Object.entries(this.#cells).filter(([, v]) => v.refreshedAt >= cutoffS),
		);
	}

	// Eviction strategy: keep the `max` most-recently-refreshed entries
	// (oldest refreshedAt dropped first). Returns count evicted. LRU-shaped
	// only when every interaction with a key ends in a set — true for
	// prMatches but not in general; readers shouldn't bank on it.
	evictOldestPast(max) {
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

async function fetchBotUserId(slack) {
	const res = await slack.call("auth.test", {});
	if (!res.ok) throw new Error(`auth.test failed: ${res.error}`);
	return res.user_id;
}

async function fetchChannels(slack) {
	const out = [];
	for await (const res of slack.paginate("conversations.list", {
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

async function discoverMatches(slack, pr, channels) {
	if (channels.length > MAX_CHANNELS_PER_RUN) {
		console.warn(
			`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; skipped ${channels.length - MAX_CHANNELS_PER_RUN} remaining`,
		);
	}
	const matches = [];
	const oldest = String(nowS() - HISTORY_LOOKBACK_S);
	for (const ch of channels.slice(0, MAX_CHANNELS_PER_RUN)) {
		for await (const res of slack.paginate(
			"conversations.history",
			{ channel: ch.id, oldest, limit: 200 },
			{ maxPages: HISTORY_PAGES_PER_CHANNEL },
		)) {
			if (!res.ok) {
				console.warn(
					`conversations.history ${ch.id}(${ch.name}): ${res.error}`,
				);
				break;
			}
			const hit = res.messages.find((msg) => linksToPR(msg, pr));
			if (hit) {
				matches.push({ channel: ch.id, ts: hit.ts });
				break;
			}
		}
	}
	return matches;
}

function warnIfUntoleratedError(res, prefix) {
	if (!res.ok && !TOLERATED_REACTION_ERRORS.has(res.error)) {
		console.warn(`${prefix}: ${res.error}`);
	}
	return res;
}

// One run's worth of reaction work; bundles the deps that would otherwise
// thread through every step.
export class Reactor {
	static #STALE_MATCH_ERRORS = new Set([
		"not_in_channel",
		"channel_not_found",
		"message_not_found",
	]);

	#slack;
	#memo;
	#prMatches;
	#job;

	constructor({ slack, memo, prMatches, job }) {
		this.#slack = slack;
		this.#memo = memo;
		this.#prMatches = prMatches;
		this.#job = job;
	}

	async run() {
		await this.#applyReactions(await this.#findMatches());
	}

	async #findMatches() {
		const cached = this.#prMatches.get(this.#job.prKey);
		if (cached?.length) return cached;
		const channels = await this.#memo.ensure(
			"channels",
			CHANNEL_LIST_TTL_S,
			() => fetchChannels(this.#slack),
		);
		return discoverMatches(this.#slack, this.#job.pr, channels);
	}

	// React to as many matches as the per-run cap allows, keeping prMatches
	// in sync per iteration so a mid-loop throw doesn't lose discovered work
	// or leave a terminal PR's entry stranded.
	async #applyReactions(matches) {
		const prKey = this.#job.prKey;
		const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);
		if (matches.length > REACTIONS_PER_RUN_CAP) {
			console.warn(
				`reactions-per-run cap (${REACTIONS_PER_RUN_CAP}) reached; ${matches.length - REACTIONS_PER_RUN_CAP} kept in cache for next run`,
			);
		}

		// Persist the full set up-front so an early throw still leaves the
		// discovered matches in cache for the next run to retry.
		let surviving = [...matches];
		this.#prMatches.set(prKey, surviving);

		for (const m of toReact) {
			const result = await this.#reactToMatch(m);
			if (Reactor.#STALE_MATCH_ERRORS.has(result.error)) {
				surviving = surviving.filter((x) => x !== m);
				this.#prMatches.set(prKey, surviving);
			}
		}

		if (this.#job.closesPR || !surviving.length) {
			this.#prMatches.delete(prKey);
		}
	}

	async #reactToMatch(match) {
		await this.#flipCleanup(match);
		return warnIfUntoleratedError(
			await this.#slack.call("reactions.add", {
				channel: match.channel,
				timestamp: match.ts,
				name: this.#job.addEmoji,
			}),
			`reactions.add ${match.channel}/${match.ts} ${this.#job.addEmoji}`,
		);
	}

	// approved↔changes-requested is the only flippable pair. Remove the
	// opposite emoji only if our own bot put it there. Skipped on re-runs
	// so a stale replay can't reverse a real later state.
	async #flipCleanup(match) {
		if (this.#job.isRerun || !this.#job.removeEmoji) return;

		const where = `${match.channel}/${match.ts}`;
		const got = warnIfUntoleratedError(
			await this.#slack.call("reactions.get", {
				channel: match.channel,
				timestamp: match.ts,
				full: true,
			}),
			`reactions.get ${where}`,
		);
		if (!got.ok) return;
		const opp = got.message?.reactions?.find(
			(r) => r.name === this.#job.removeEmoji,
		);
		if (!opp) return;
		const botUserId = await this.#memo.ensure(
			"botUserId",
			BOT_USER_ID_TTL_S,
			() => fetchBotUserId(this.#slack),
		);
		if (!opp.users.includes(botUserId)) return;

		warnIfUntoleratedError(
			await this.#slack.call("reactions.remove", {
				channel: match.channel,
				timestamp: match.ts,
				name: this.#job.removeEmoji,
			}),
			`reactions.remove ${where} ${this.#job.removeEmoji}`,
		);
	}
}

function readJob() {
	const eventPath = FatalError.notNull(
		process.env.GITHUB_EVENT_PATH,
		"GITHUB_EVENT_PATH not set; not running inside GitHub Actions",
	);
	const eventName = FatalError.notNull(
		process.env.GITHUB_EVENT_NAME,
		"GITHUB_EVENT_NAME not set; not running inside GitHub Actions",
	);
	const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

	const status = deriveStatus(eventName, payload);
	if (!status) return null;
	const addEmoji = input(`emoji-${status}`);
	if (!addEmoji) return null;

	const token = input("slack-token");
	if (!token) {
		// Fork PRs run with empty secrets
		if (payload.pull_request?.head?.repo?.fork) return null;
		throw new FatalError("slack-token is missing; set the SLACK_TOKEN secret");
	}

	const pr = FatalError.notNull(
		prContext(payload),
		"could not derive PR context from payload",
	);

	const opposite = FLIP_OPPOSITE[status];
	const removeEmoji = opposite ? input(`emoji-${opposite}`) : "";

	return {
		status,
		token,
		addEmoji,
		removeEmoji,
		isRerun: Number(process.env.GITHUB_RUN_ATTEMPT) > 1,
		closesPR: status === STATUS_MERGED || status === STATUS_CLOSED,
		pr,
		prKey: `${pr.owner}/${pr.repo}#${pr.num}`,
	};
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

	prMatches.evictOlderThan(nowS() - PR_STALE_TTL_S);
	const reactor = new Reactor({ slack, memo, prMatches, job });
	try {
		await reactor.run();
	} finally {
		const evicted = prMatches.evictOldestPast(MAX_PR_ENTRIES);
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
