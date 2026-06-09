// SPDX-License-Identifier: MIT
const REACTIONS_PER_RUN_CAP = 50;

const STALE_MATCH_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"message_not_found",
]);
const GET_IGNORE = [...STALE_MATCH_ERRORS];
const ADD_IGNORE = [...STALE_MATCH_ERRORS, "already_reacted"];
const REMOVE_IGNORE = [...STALE_MATCH_ERRORS, "no_reaction"];

export async function applyReactions(slack, state, job, matches) {
	const stale = new Set();
	for (const m of matches.slice(0, REACTIONS_PER_RUN_CAP)) {
		const result = await reconcileMatch(slack, state, job, m);
		if (STALE_MATCH_ERRORS.has(result.error)) {
			stale.add(m);
			state.setLinks(job.prKey, matches.filter((x) => !stale.has(x)));
		}
	}
	// Drop immediately on close/merge rather than wait for TTL expiry.
	if (job.closesPR || (stale.size > 0 && stale.size === matches.length)) {
		state.deleteLinks(job.prKey);
	}
}

async function reconcileMatch(slack, state, job, match) {
	const got = await slack.call("reactions.get", {
		params: { channel: match.channel, timestamp: match.ts, full: true },
		ignoreErrors: GET_IGNORE,
	});
	if (!got.ok) return got;

	const botOwned = await botOwnedManaged(
		slack,
		state,
		job.managed,
		got.message.reactions ?? [],
	);
	const removes = [...botOwned.difference(job.desired)].map((name) =>
		callReaction(slack, "reactions.remove", match, name, REMOVE_IGNORE),
	);
	const adds = [...job.desired.difference(botOwned)].map((name) =>
		callReaction(slack, "reactions.add", match, name, ADD_IGNORE),
	);
	const results = await Promise.all([...removes, ...adds]);
	return results.find((r) => STALE_MATCH_ERRORS.has(r.error)) ?? { ok: true };
}

async function botOwnedManaged(slack, state, managed, reactions) {
	const ours = reactions.filter((r) => managed.has(r.name));
	if (ours.length === 0) return new Set();
	const botUserId = await state.getBotUserId(() => fetchBotUserId(slack));
	return new Set(
		ours.filter((r) => r.users.includes(botUserId)).map((r) => r.name),
	);
}

function callReaction(slack, method, match, name, ignoreErrors) {
	return slack.call(method, {
		params: { channel: match.channel, timestamp: match.ts, name },
		ignoreErrors,
	});
}

async function fetchBotUserId(slack) {
	const res = await slack.call("auth.test", { mustSucceed: true });
	return res.user_id;
}
