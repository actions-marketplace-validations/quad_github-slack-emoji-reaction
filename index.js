import fs from "node:fs";

// ---------------------------------------------------------------- constants

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
const CACHE_KEY_PREFIX = "slack-emoji-reactions-state-";
const CACHE_VERSION = "slack-emoji-reactions-v1";

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] || "";

const sweepStale = (entries, cutoffS) =>
	Object.fromEntries(
		Object.entries(entries).filter(([, v]) => (v.lastTouched || 0) >= cutoffS),
	);

const capByLru = (entries, max) => {
	const keys = Object.keys(entries);
	if (keys.length <= max) return entries;
	keys.sort(
		(a, b) => (entries[a].lastTouched || 0) - (entries[b].lastTouched || 0),
	);
	return Object.fromEntries(
		keys.slice(keys.length - max).map((k) => [k, entries[k]]),
	);
};

const keepsMatch = (result) => !STALE_MATCH_ERRORS.has(result.error);

export class AuthError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

// ---------------------------------------------------------------- slack client

export function createSlackClient({
	token,
	fetch = globalThis.fetch,
	paceMs = SLACK_PACE_MS,
} = {}) {
	let lastCallAt = 0;

	async function call(method, params) {
		const url = SLACK_API + method;
		let lastBody;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const wait = paceMs - (Date.now() - lastCallAt);
			if (wait > 0) await sleep(wait);
			lastCallAt = Date.now();

			let res;
			try {
				res = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
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

			const isRateLimited =
				res.status === 429 ||
				(lastBody?.ok === false && lastBody.error === "ratelimited");
			if (!isRateLimited) return lastBody;

			const retry = Math.min(
				parseInt(res.headers.get("retry-after"), 10) || 1,
				RETRY_AFTER_CAP_S,
			);
			console.log(
				`slack ${method} ratelimited; retry-after ${retry}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
			);
			if (attempt >= MAX_RETRIES) break;
			await sleep(retry * 1000);
		}
		return lastBody ?? { ok: false, error: "ratelimited" };
	}

	return { call };
}

function checkAuth(res) {
	if (res?.ok === false && AUTH_ERRORS.has(res.error)) {
		throw new AuthError(res.error);
	}
}

// ---------------------------------------------------------------- url match

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

export function matchesPullUrl(candidate, owner, repo, num) {
	let u;
	try {
		u = new URL(candidate);
	} catch {
		return false;
	}
	if (u.host !== "github.com") return false;
	const parts = u.pathname.split("/");
	return (
		parts.length === 5 &&
		parts[0] === "" &&
		parts[1] === owner &&
		parts[2] === repo &&
		parts[3] === "pull" &&
		parts[4] === String(num)
	);
}

// ---------------------------------------------------------------- event → status

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

// ---------------------------------------------------------------- discovery

export async function ensureBotUserId(state, slack) {
	if (state.botUserId) return state.botUserId;
	const res = await slack.call("auth.test", {});
	checkAuth(res);
	if (!res.ok) throw new Error(`auth.test failed: ${res.error}`);
	state.botUserId = res.user_id;
	console.log(`auth.test → bot user ${state.botUserId}`);
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
		for (const c of res.channels || []) {
			if (c.is_member) channels.push({ id: c.id, name: c.name });
		}
		cursor = res.response_metadata?.next_cursor || "";
		if (!cursor) break;
	}
	state.channels = channels;
	state.channelsRefreshedAt = nowS();
	console.log(`channels refreshed: ${channels.length} bot-member channel(s)`);
	return channels;
}

export async function discoverMatches(channels, owner, repo, num, slack) {
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
			for (const msg of res.messages || []) {
				if (
					urlsFromMessage(msg).some((c) => matchesPullUrl(c, owner, repo, num))
				) {
					matches.push({ channel: ch.id, ts: msg.ts });
					foundInChannel = true;
					break;
				}
			}
			cursor = res.response_metadata?.next_cursor || "";
			if (!cursor || !res.has_more) break;
		}
		if (foundInChannel) console.log(`match in #${ch.name} (${ch.id})`);
	}
	return matches;
}

// ---------------------------------------------------------------- reactions

export async function reactToMatch(match, ctx) {
	const { status, emoji, oppositeEmoji, botUserId, isRerun, slack } = ctx;
	const where = `${match.channel}/${match.ts}`;

	if (!isRerun && oppositeEmoji) {
		const got = await slack.call("reactions.get", {
			channel: match.channel,
			timestamp: match.ts,
			full: true,
		});
		checkAuth(got);
		if (got.ok) {
			const opp = (got.message?.reactions || []).find(
				(r) => r.name === oppositeEmoji,
			);
			if (opp?.users?.includes(botUserId)) {
				const rm = await slack.call("reactions.remove", {
					channel: match.channel,
					timestamp: match.ts,
					name: oppositeEmoji,
				});
				checkAuth(rm);
				console.log(
					JSON.stringify({
						match: where,
						status,
						action: "remove",
						name: oppositeEmoji,
						ok: !!rm.ok,
						error: rm.error || null,
					}),
				);
			}
		} else if (!TOLERATED_REACTION_ERRORS.has(got.error)) {
			console.warn(`reactions.get ${where}: ${got.error}`);
		}
	}

	const add = await slack.call("reactions.add", {
		channel: match.channel,
		timestamp: match.ts,
		name: emoji,
	});
	checkAuth(add);
	console.log(
		JSON.stringify({
			match: where,
			status,
			action: "add",
			name: emoji,
			ok: !!add.ok,
			error: add.error || null,
		}),
	);
	return { ok: !!add.ok, error: add.error };
}

// ---------------------------------------------------------------- cache (GHA v1 API)

export function createCache({
	env = process.env,
	fetch = globalThis.fetch,
} = {}) {
	const rawBase = env.ACTIONS_CACHE_URL || "";
	const base = rawBase.endsWith("/") ? rawBase : rawBase ? `${rawBase}/` : "";
	const token = env.ACTIONS_RUNTIME_TOKEN || "";
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json;api-version=6.0-preview.1",
	};
	const enabled = !!base && !!token;
	const url = (path) => new URL(`_apis/artifactcache/${path}`, base);
	const send = (path, init = {}) =>
		fetch(url(path), {
			...init,
			headers: { ...headers, ...(init.headers || {}) },
		});

	async function restore() {
		if (!enabled) return null;
		try {
			const lookup = url("cache");
			// Primary key won't match anything we ever save; second is the prefix.
			lookup.searchParams.set(
				"keys",
				`${CACHE_KEY_PREFIX}__sentinel__,${CACHE_KEY_PREFIX}`,
			);
			lookup.searchParams.set("version", CACHE_VERSION);
			const res = await fetch(lookup, { headers });
			if (res.status === 204) {
				console.log("cache: cold (no prior entry)");
				return null;
			}
			if (!res.ok) {
				console.warn(`cache restore lookup status ${res.status}`);
				return null;
			}
			const meta = await res.json();
			if (!meta?.archiveLocation) return null;
			const blob = await fetch(meta.archiveLocation);
			if (!blob.ok) {
				console.warn(`cache blob fetch status ${blob.status}`);
				return null;
			}
			const state = await blob.json();
			console.log(`cache: restored ${meta.cacheKey}`);
			return state;
		} catch (e) {
			console.warn(`cache restore failed: ${e.message}`);
			return null;
		}
	}

	async function save(state, key) {
		if (!enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");

			const reserveRes = await send("caches", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key,
					version: CACHE_VERSION,
					cacheSize: body.length,
				}),
			});
			if (!reserveRes.ok) {
				console.warn(`cache reserve status ${reserveRes.status}`);
				return;
			}
			const cacheId = (await reserveRes.json())?.cacheId;
			if (!cacheId) return;

			const uploadRes = await send(`caches/${cacheId}`, {
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

			const commitRes = await send(`caches/${cacheId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ size: body.length }),
			});
			if (!commitRes.ok) {
				console.warn(`cache commit status ${commitRes.status}`);
				return;
			}
			console.log(`cache: saved ${key} (${body.length} bytes)`);
		} catch (e) {
			console.warn(`cache save failed: ${e.message}`);
		}
	}

	return { restore, save };
}

// ---------------------------------------------------------------- main

async function main() {
	const token = input("slack-token").trim();
	if (!token) {
		console.log("slack-token empty; skipping");
		return;
	}
	console.log(`::add-mask::${token}`);
	const slack = createSlackClient({ token });

	const eventPath = process.env.GITHUB_EVENT_PATH;
	const eventName = process.env.GITHUB_EVENT_NAME;
	if (!eventPath || !eventName) {
		console.error("GITHUB_EVENT_PATH/GITHUB_EVENT_NAME not set");
		return;
	}
	const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

	const status = deriveStatus(eventName, payload);
	if (!status) {
		console.log(`event ${eventName}.${payload.action} → no status mapping`);
		return;
	}

	const emoji = input(`emoji-${status}`).trim();
	if (!emoji) {
		console.log(`status ${status} has no configured emoji; skipping`);
		return;
	}

	const opposite = FLIP_OPPOSITE[status] || null;
	const oppositeEmoji = opposite
		? input(`emoji-${opposite}`).trim() || null
		: null;

	const isRerun = parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) > 1;
	if (isRerun) console.log("run_attempt > 1: skipping flip cleanup for safety");

	const prCtx = prContext(payload);
	if (!prCtx) {
		console.error("could not derive PR context from payload");
		return;
	}
	const prKey = `${prCtx.owner}/${prCtx.repo}#${prCtx.num}`;

	const cache = createCache();
	const state = (await cache.restore()) || {};
	const beforeSweep = state.prMatches || {};
	state.prMatches = sweepStale(beforeSweep, nowS() - PR_STALE_TTL_S);
	let dirty =
		Object.keys(state.prMatches).length !== Object.keys(beforeSweep).length;
	if (dirty) {
		const swept =
			Object.keys(beforeSweep).length - Object.keys(state.prMatches).length;
		console.log(`cache: swept ${swept} stale entr${swept === 1 ? "y" : "ies"}`);
	}

	try {
		let matches;
		const cached = state.prMatches[prKey]?.matches;
		if (cached?.length) {
			matches = cached;
			console.log(`cache hit for ${prKey}: ${matches.length} match(es)`);
		} else {
			await ensureBotUserId(state, slack);
			const channels = await ensureChannels(state, slack);
			console.log(
				`scanning ${Math.min(channels.length, MAX_CHANNELS_PER_RUN)} channel(s) for ${prCtx.prUrl}`,
			);
			matches = await discoverMatches(
				channels,
				prCtx.owner,
				prCtx.repo,
				prCtx.num,
				slack,
			);
			console.log(`discovery: ${matches.length} match(es) for ${prKey}`);
			dirty = true;
		}

		const reactCtx = {
			status,
			emoji,
			oppositeEmoji,
			botUserId: state.botUserId,
			isRerun,
			slack,
		};
		const needsBotIdForFlip =
			oppositeEmoji && !isRerun && matches.length && !reactCtx.botUserId;
		if (needsBotIdForFlip) {
			reactCtx.botUserId = await ensureBotUserId(state, slack);
			dirty = true;
		}

		// Split matches into the portion we'll react to this run + the overflow
		// that gets carried forward in the cache so the next run picks it up.
		const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);
		const overflow = matches.slice(REACTIONS_PER_RUN_CAP);
		if (overflow.length) {
			console.warn(
				`reactions-per-run cap (${REACTIONS_PER_RUN_CAP}) reached; ${overflow.length} kept in cache for next run`,
			);
		}

		const reacted = [];
		for (const m of toReact) reacted.push([m, await reactToMatch(m, reactCtx)]);
		const survivors = [
			...reacted.filter(([, r]) => keepsMatch(r)).map(([m]) => m),
			...overflow,
		];

		// Reaction loop always touches the entry (delete on terminal, rewrite
		// with bumped lastTouched on continuing). Mark dirty unconditionally.
		dirty = true;
		const isTerminal = status === STATUS_MERGED || status === STATUS_CLOSED;
		const { [prKey]: _evicted, ...rest } = state.prMatches;
		state.prMatches =
			isTerminal || !survivors.length
				? rest
				: { ...rest, [prKey]: { matches: survivors, lastTouched: nowS() } };

		const beforeCap = state.prMatches;
		state.prMatches = capByLru(state.prMatches, MAX_PR_ENTRIES);
		if (Object.keys(state.prMatches).length !== Object.keys(beforeCap).length) {
			console.warn(
				`pr-entries safety cap; evicted ${Object.keys(beforeCap).length - Object.keys(state.prMatches).length}`,
			);
		}
	} catch (e) {
		if (e instanceof AuthError) {
			console.error(
				`Slack auth error: ${e.code} — exiting cleanly. Refresh the SLACK_TOKEN secret.`,
			);
			return;
		}
		throw e;
	}

	if (!dirty) {
		console.log("cache: state unchanged; skipping save");
		return;
	}
	const runId = process.env.GITHUB_RUN_ID || "norunid";
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
	await cache.save(state, `${CACHE_KEY_PREFIX}${runId}-${runAttempt}`);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e?.stack || String(e));
		process.exit(1);
	});
}
