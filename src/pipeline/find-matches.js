// SPDX-License-Identifier: MIT
import * as log from "../log.js";
import { prKey } from "./job.js";

const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
// Slack's per-page limit on conversations.list/history. Default 100, max
// 1000; 200 trades fewer pages for batches that aren't pathologically big.
const SLACK_PAGE_SIZE = 200;

const STALE_CHANNEL_ERRORS = new Set([
	"channel_not_found",
	"not_in_channel",
	"is_archived",
]);

export async function findMatches(slack, state, job) {
	const channels = await state.getChannels(() => fetchChannels(slack));
	if (channels.length > MAX_CHANNELS_PER_RUN) {
		log.warn(
			`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; ${channels.length - MAX_CHANNELS_PER_RUN} not scanned this run`,
		);
	}
	const channelSample = shuffle(channels).slice(0, MAX_CHANNELS_PER_RUN);

	await ingestNewForAllPrs(slack, state, job.pr, channelSample);
	await ingestOldForOnePr(slack, state, job.pr, channelSample);

	// touch so active PRs don't age out of the stale sweep between events.
	state.touchLinks(job.prKey);
	return state.getLinks(job.prKey) ?? [];
}

async function fetchChannels(slack) {
	const out = [];
	for await (const res of slack.paginate("conversations.list", {
		params: {
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: SLACK_PAGE_SIZE,
		},
		maxPages: Infinity,
		mustSucceed: true,
	})) {
		for (const c of res.channels) {
			if (c.is_member) out.push({ id: c.id, name: c.name });
		}
	}
	return out;
}

// JSON.stringify flattens every Slack message shape (text <url>, attachments,
// blocks) into a string the URL survives literally; \b closes the /pull/12
// vs /pull/123 substring trap. `root` is excluded so a thread_broadcast
// doesn't false-match on the parent's content embedded under it.
function extractPRUrls(pr, msg) {
	const base = prKey({ ...pr, num: "" });
	const re = new RegExp(`${RegExp.escape(base)}\\d+\\b`, "g");
	return JSON.stringify(msg, (k, v) => (k === "root" ? undefined : v)).match(re) ?? [];
}

function shuffle(arr) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// Returns accumulated messages even on mid-pagination error; stale errors also drop the channel cache.
async function scanHistory(slack, state, channel, oldest) {
	const messages = [];
	let newestTs = null;
	for await (const res of slack.paginate("conversations.history", {
		params: { channel: channel.id, oldest, limit: SLACK_PAGE_SIZE },
		maxPages: HISTORY_PAGES_PER_CHANNEL,
	})) {
		if (!res.ok) {
			if (STALE_CHANNEL_ERRORS.has(res.error)) state.dropChannels();
			return { ok: false, newestTs, messages };
		}
		// conversations.history returns newest-first; capture once on the first page.
		if (newestTs === null && res.messages.length > 0) newestTs = res.messages[0].ts;
		messages.push(...res.messages);
	}
	return { ok: true, newestTs, messages };
}

async function ingestNewForAllPrs(slack, state, pr, channels) {
	const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_S);
	for (const ch of channels) {
		const { ok, newestTs, messages } = await scanHistory(slack, state, ch, state.getCursor(ch.id) ?? oldest);
		if (!ok) { state.dropCursor(ch.id); continue; }
		if (newestTs !== null) state.setCursor(ch.id, newestTs);
		for (const msg of messages)
			for (const url of extractPRUrls(pr, msg))
				state.mergeLink(url, { channel: ch.id, ts: msg.ts });
	}
}

async function ingestOldForOnePr(slack, state, pr, channels) {
	const key = prKey(pr);
	if (state.getLinks(key) !== undefined) return;
	const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_S);
	// React on hit.ts even when hit is a thread_broadcast: with `root` excluded
	// from matching, a broadcast only hits when its own content links to the PR,
	// and that broadcast is what users see in-channel — the reaction belongs there.
	const failedChannels = new Set();
	const scans = channels.map(async (ch) => {
		const { ok, messages } = await scanHistory(slack, state, ch, oldest);
		if (!ok) failedChannels.add(ch.id);
		return messages
			.filter((msg) => extractPRUrls(pr, msg).includes(key))
			.map(({ ts }) => ({ channel: ch.id, ts }));
	});
	const matches = (await Promise.all(scans)).flat();
	// Drop errored cursors so the next ingest re-covers from HISTORY_LOOKBACK_S.
	for (const id of failedChannels) state.dropCursor(id);
	// [] = searched and found nothing (suppress re-scan); undefined = may have missed pages (retry next event).
	if (failedChannels.size === 0 || matches.length > 0) {
		state.setLinks(key, matches);
	}
}
