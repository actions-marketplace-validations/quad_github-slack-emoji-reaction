import * as log from "../log.js";

const CHANNEL_LIST_TTL_S = 24 * 3600;
// Matches GHA's own 7-day cache-entry inactivity TTL — the natural ceiling.
const PR_STALE_TTL_S = 7 * 24 * 3600;
const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
// Slack's per-page limit on conversations.list/history. Default 100, max
// 1000; 200 trades fewer pages for batches that aren't pathologically big.
const SLACK_PAGE_SIZE = 200;

// Slack's already told us we're effectively out; drop the channel cache
// so the next run refetches.
const STALE_CHANNEL_ERRORS = new Set([
	"channel_not_found",
	"not_in_channel",
	"is_archived",
]);

export async function findMatches(slack, memo, prMatches, job) {
	prMatches.evictOlderThan(PR_STALE_TTL_S);
	return prMatches.getOrSet(job.prKey, PR_STALE_TTL_S, async () =>
		discoverMatches(
			slack,
			memo,
			job.pr,
			await memo.getOrSet("channels", CHANNEL_LIST_TTL_S, () =>
				fetchChannels(slack),
			),
		),
	);
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
// vs /pull/123 substring trap.
function linksTo(pr) {
	const target = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.num}`;
	const re = new RegExp(`${RegExp.escape(target)}\\b`);
	return (msg) => re.test(JSON.stringify(msg));
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
	const linksToPR = linksTo(pr);
	const matches = [];
	const oldest = `${Math.floor(Date.now() / 1000) - HISTORY_LOOKBACK_S}`;
	for (const ch of sample.slice(0, MAX_CHANNELS_PER_RUN)) {
		for await (const res of slack.paginate("conversations.history", {
			params: { channel: ch.id, oldest, limit: SLACK_PAGE_SIZE },
			maxPages: HISTORY_PAGES_PER_CHANNEL,
		})) {
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
