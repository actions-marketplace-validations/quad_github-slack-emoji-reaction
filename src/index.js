import fs from "node:fs";

import { CacheClient } from "./cache.js";
import { FatalError } from "./errors.js";
import * as log from "./log.js";
import { Memo } from "./memo.js";
import { SlackClient } from "./slack.js";

const STATUS_APPROVED = "approved";
const STATUS_CHANGES_REQUESTED = "changes-requested";
const STATUS_COMMENTED = "commented";
const STATUS_MERGED = "merged";
const STATUS_CLOSED = "closed";

const FLIP_OPPOSITE = {
	[STATUS_APPROVED]: STATUS_CHANGES_REQUESTED,
	[STATUS_CHANGES_REQUESTED]: STATUS_APPROVED,
};

// Slack's already told us we're effectively out; drop the channel cache
// so the next run refetches.
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
// Slack's per-page limit on conversations.list/history. Default 100, max
// 1000; 200 trades fewer pages for batches that aren't pathologically big.
const SLACK_PAGE_SIZE = 200;

export function deriveStatus(eventName, payload) {
	if (eventName === "pull_request_review") {
		if (payload.action !== "submitted") return null;
		const state = payload.review?.state;
		if (state === "approved") return STATUS_APPROVED;
		if (state === "changes_requested") return STATUS_CHANGES_REQUESTED;
		if (state === "commented") {
			// Bot-filed reviews (Dependabot, Renovate, etc.) are constant noise.
			if (payload.review?.user?.type === "Bot") return null;
			return STATUS_COMMENTED;
		}
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
			limit: SLACK_PAGE_SIZE,
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

function shuffle(arr) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function discoverMatches(slack, memo, pr, channels) {
	// Shuffle so consecutive events for the same PR sample different
	// channels; bots invited to many channels get full coverage across
	// runs instead of always missing the same tail.
	const sample = shuffle(channels);
	if (sample.length > MAX_CHANNELS_PER_RUN) {
		log.warn(
			`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; ${sample.length - MAX_CHANNELS_PER_RUN} not scanned this run`,
		);
	}
	// JSON.stringify flattens every Slack message shape (text <url>,
	// attachments, blocks) into a string the URL survives literally; \b
	// closes the /pull/12 vs /pull/123 substring trap.
	const target = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.num}`;
	const linkRe = new RegExp(`${RegExp.escape(target)}\\b`);
	const linksToPR = (msg) => linkRe.test(JSON.stringify(msg));

	const matches = [];
	const oldest = `${Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_S}`;
	for (const ch of sample.slice(0, MAX_CHANNELS_PER_RUN)) {
		for await (const res of slack.paginate(
			"conversations.history",
			{ channel: ch.id, oldest, limit: SLACK_PAGE_SIZE },
			HISTORY_PAGES_PER_CHANNEL,
		)) {
			if (!res.ok) {
				if (STALE_CHANNEL_ERRORS.has(res.error)) memo.delete("channels");
				break;
			}
			const hit = res.messages.find(linksToPR);
			if (hit) {
				matches.push({ channel: ch.id, ts: hit.ts });
				break;
			}
		}
	}
	return matches;
}

// One run's worth of reaction work
export class Reactor {
	static #STALE_MATCH_ERRORS = new Set([
		"not_in_channel",
		"channel_not_found",
		"message_not_found",
	]);

	static #TOLERATED_REACTION_ERRORS = new Set([
		"already_reacted",
		"no_reaction",
		"not_in_channel",
		"channel_not_found",
		"message_not_found",
	]);

	static #warnIfUntolerated(res, prefix) {
		if (!res.ok && !Reactor.#TOLERATED_REACTION_ERRORS.has(res.error)) {
			log.warn(`${prefix}: ${res.error}`);
		}
		return res;
	}

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

	// Returns the cached matches if we already have them, otherwise discovers
	// fresh and caches them. Caching here (not in #applyReactions) means a
	// throw mid-loop still leaves the discovered matches available next run.
	async #findMatches() {
		const prKey = this.#job.prKey;
		const cached = this.#prMatches.get(prKey);
		if (cached?.length) return cached;
		const channels = await this.#memo.ensure(
			"channels",
			CHANNEL_LIST_TTL_S,
			() => fetchChannels(this.#slack),
		);
		const matches = await discoverMatches(
			this.#slack,
			this.#memo,
			this.#job.pr,
			channels,
		);
		this.#prMatches.set(prKey, matches);
		return matches;
	}

	// React to as many matches as the per-run cap allows; the rest roll
	// over via the cache.
	async #applyReactions(matches) {
		const prKey = this.#job.prKey;
		const toReact = matches.slice(0, REACTIONS_PER_RUN_CAP);
		let surviving = [...matches];

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
		return Reactor.#warnIfUntolerated(
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
		const got = Reactor.#warnIfUntolerated(
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

		Reactor.#warnIfUntolerated(
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
	// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
	const input = (name) =>
		(process.env[`INPUT_${name.toUpperCase()}`] || "").trim();

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

		const parts = [];
		for (let cur = e; cur; cur = cur.cause) parts.push(cur.message);
		log.error(parts.join(": "));

		process.exit(1);
	}
}
