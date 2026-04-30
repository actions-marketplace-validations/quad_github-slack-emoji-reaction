import fs from "node:fs";

import { CacheClient } from "./cache.js";
import { FatalError } from "./errors.js";
import { Memo } from "./memo.js";
import { SlackClient } from "./slack.js";

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

// Errors that indicate our cached channel list is stale (bot was removed
// from the channel, or the channel was archived since we last refreshed).
// We can't /leave — Slack's already told us we're effectively out — but
// we can drop the channel cache so the next run refetches.
const STALE_CHANNEL_ERRORS = new Set([
	"channel_not_found",
	"not_in_channel",
	"is_archived",
]);

const BOT_USER_ID_TTL_S = 30 * 24 * 3600;
const CHANNEL_LIST_TTL_S = 24 * 3600;
const PR_STALE_TTL_S = 90 * 24 * 3600;
const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
const REACTIONS_PER_RUN_CAP = 50;
const MAX_PR_ENTRIES = 10000;
const RUN_DEADLINE_MS = 5 * 60 * 1000;

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

async function fetchBotUserId(slack) {
	const res = await slack.call("auth.test", {});
	if (!res.ok) throw FatalError.fromSlack("auth.test", res);
	return res.user_id;
}

async function fetchChannels(slack) {
	const out = [];
	for await (const res of slack.paginate(
		"conversations.list",
		{
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: 200,
		},
		Infinity,
	)) {
		if (!res.ok) throw FatalError.fromSlack("conversations.list", res);
		for (const c of res.channels) {
			if (c.is_member) out.push({ id: c.id, name: c.name });
		}
	}
	return out;
}

async function discoverMatches(slack, memo, pr, channels) {
	if (channels.length > MAX_CHANNELS_PER_RUN) {
		console.warn(
			`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; skipped ${channels.length - MAX_CHANNELS_PER_RUN} remaining`,
		);
	}
	const matches = [];
	const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_S);
	for (const ch of channels.slice(0, MAX_CHANNELS_PER_RUN)) {
		for await (const res of slack.paginate(
			"conversations.history",
			{ channel: ch.id, oldest, limit: 200 },
			HISTORY_PAGES_PER_CHANNEL,
		)) {
			if (!res.ok) {
				if (STALE_CHANNEL_ERRORS.has(res.error)) memo.delete("channels");
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
		return discoverMatches(this.#slack, this.#memo, this.#job.pr, channels);
	}

	// React to as many matches as the per-run cap allows; the rest roll
	// over via the cache.
	async #applyReactions(matches) {
		const prKey = this.#job.prKey;
		const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);

		// Persist the full set up-front so a throw mid-loop still leaves the
		// discovered matches in cache for the next run; keep it in sync as
		// stale matches drop out.
		let surviving = [...matches];
		this.#prMatches.set(prKey, surviving);

		for (const m of toReact) {
			const result = await this.#reactToMatch(m);
			if (Reactor.#STALE_MATCH_ERRORS.has(result.error)) {
				surviving = surviving.filter((x) => x !== m);
				this.#prMatches.set(prKey, surviving);
			}
		}

		// Terminal events (closed/merged) are the last in the PR's lifecycle;
		// drop the entry rather than wait for the 90-day sweep.
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

	// finally still saves whatever progress made it before any abort.
	const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
	const slack = new SlackClient({
		token: job.token,
		fetch: globalThis.fetch,
		signal: deadline,
	});
	const cache = new CacheClient();
	const restored = (await cache.restore(deadline)) ?? {};
	const memo = new Memo(restored.memo ?? {});
	const prMatches = new Memo(restored.prMatches ?? {});

	prMatches.evictOlderThan(PR_STALE_TTL_S);
	const reactor = new Reactor({ slack, memo, prMatches, job });
	try {
		await reactor.run();
	} finally {
		prMatches.evictOldestPast(MAX_PR_ENTRIES);
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
