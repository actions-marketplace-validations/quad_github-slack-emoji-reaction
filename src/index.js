// SPDX-License-Identifier: MIT
import { CacheClient } from "./cache.js";
import { FatalError } from "./errors.js";
import { GitHubClient } from "./github.js";
import * as log from "./log.js";
import { Memo } from "./memo.js";
import { applyReactions } from "./pipeline/apply-reactions.js";
import { findMatches } from "./pipeline/find-matches.js";
import { desiredEmojis, fetchPRState, readJob } from "./pipeline/job.js";
import { SlackClient } from "./slack.js";

const MAX_PR_ENTRIES = 10000;
const RUN_DEADLINE_MS = 5 * 60 * 1000;

async function main() {
	const job = readJob();
	if (!job) return;
	console.log(`::add-mask::${job.slackToken}`);

	const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
	const cache = new CacheClient();
	const restored = (await cache.restore(deadline)) ?? {};
	const memo = new Memo(restored.memo ?? {});
	const prMatches = new Memo(restored.prMatches ?? {});

	const github = new GitHubClient(job.githubToken, deadline);
	const state = await fetchPRState(github, job.pr);
	const reconciled = {
		...job,
		desired: desiredEmojis(state, job.cfg),
		managed: new Set(Object.values(job.cfg)),
		closesPR: state.merged || state.closed,
	};

	const slack = new SlackClient(job.slackToken, deadline);

	try {
		const matches = await findMatches(slack, memo, prMatches, reconciled);
		await applyReactions(slack, memo, prMatches, reconciled, matches);
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
