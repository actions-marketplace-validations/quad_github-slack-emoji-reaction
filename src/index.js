// SPDX-License-Identifier: MIT
import { CacheClient } from "./cache.js";
import { FatalError } from "./errors.js";
import { GitHubClient } from "./github.js";
import * as log from "./log.js";
import { State } from "./state.js";
import { applyReactions } from "./pipeline/apply-reactions.js";
import { findMatches } from "./pipeline/find-matches.js";
import { desiredEmojis, fetchPRState, readJob } from "./pipeline/job.js";
import { SlackClient } from "./slack.js";

const RUN_DEADLINE_MS = 5 * 60 * 1000;

async function main() {
	const job = readJob();
	if (!job) return;
	console.log(`::add-mask::${job.slackToken}`);

	const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
	const cache = new CacheClient();
	const restored = (await cache.restore(deadline)) ?? {};
	const state = new State(restored);

	const github = new GitHubClient(job.githubToken, deadline);
	const prState = await fetchPRState(github, job.pr);
	const reconciled = {
		...job,
		desired: desiredEmojis(prState, job.cfg),
		managed: new Set(Object.values(job.cfg)),
		closesPR: prState.merged || prState.closed,
	};

	const slack = new SlackClient(job.slackToken, deadline);

	try {
		const matches = await findMatches(slack, state, reconciled);
		await applyReactions(slack, state, reconciled, matches);
	} finally {
		state.evict();
		await cache.save(state);
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
