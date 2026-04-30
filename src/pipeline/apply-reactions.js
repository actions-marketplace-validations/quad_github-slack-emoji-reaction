const BOT_USER_ID_TTL_S = 30 * 24 * 3600;
const REACTIONS_PER_RUN_CAP = 50;

const STALE_MATCH_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"message_not_found",
]);
const EXPECTED_REACTION_ERRORS = [
	"already_reacted",
	"no_reaction",
	...STALE_MATCH_ERRORS,
];

// React to as many matches as the per-run cap allows; the rest roll over via
// the cache.
export async function applyReactions(slack, memo, prMatches, job, matches) {
	const stale = new Set();
	for (const m of matches.slice(0, REACTIONS_PER_RUN_CAP)) {
		const result = await reactToMatch(slack, memo, job, m);
		if (STALE_MATCH_ERRORS.has(result.error)) {
			stale.add(m);
			prMatches.set(
				job.prKey,
				matches.filter((x) => !stale.has(x)),
			);
		}
	}
	// Terminal events (closed/merged) are the last in the PR's lifecycle;
	// drop the entry now rather than wait for the stale-TTL sweep.
	if (job.closesPR || matches.every((m) => stale.has(m))) {
		prMatches.delete(job.prKey);
	}
}

async function reactToMatch(slack, memo, job, match) {
	await withdrawOpposite(slack, memo, job, match);
	return slack.call("reactions.add", {
		params: { channel: match.channel, timestamp: match.ts, name: job.emoji },
		ignoreErrors: EXPECTED_REACTION_ERRORS,
	});
}

// approved↔changes-requested is the only flippable pair. Withdraw the
// opposite reaction only if the bot placed it. Skipped on re-runs so a stale
// replay can't reverse a real later state.
async function withdrawOpposite(slack, memo, job, match) {
	if (job.isRerun || !job.opposite) return;

	const got = await slack.call("reactions.get", {
		params: { channel: match.channel, timestamp: match.ts, full: true },
		ignoreErrors: EXPECTED_REACTION_ERRORS,
	});
	if (!got.ok) return;
	const opp = got.message?.reactions?.find((r) => r.name === job.opposite);
	if (!opp) return;
	const botUserId = await memo.getOrSet("botUserId", BOT_USER_ID_TTL_S, () =>
		fetchBotUserId(slack),
	);
	if (!opp.users.includes(botUserId)) return;

	await slack.call("reactions.remove", {
		params: {
			channel: match.channel,
			timestamp: match.ts,
			name: job.opposite,
		},
		ignoreErrors: EXPECTED_REACTION_ERRORS,
	});
}

async function fetchBotUserId(slack) {
	const res = await slack.call("auth.test", { mustSucceed: true });
	return res.user_id;
}
