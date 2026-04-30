// SPDX-License-Identifier: MIT
import fs from "node:fs";

import { FatalError } from "../errors.js";

const STATUS_PREDICATES = {
	approved: (s) => s.reviewDecision === "approved",
	"changes-requested": (s) => s.reviewDecision === "changes_requested",
	commented: (s) => s.hasUserComment,
	merged: (s) => s.merged,
	closed: (s) => !s.merged && s.closed,
};

export function desiredEmojis(state, cfg) {
	return new Set(
		Object.entries(cfg)
			.filter(([key, emoji]) => emoji && STATUS_PREDICATES[key](state))
			.map(([, emoji]) => emoji),
	);
}

const PR_QUERY = `query($owner: String!, $repo: String!, $num: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $num) {
      merged
      closed
      reviewDecision
      reviews(first: 100, states: [COMMENTED]) { nodes { author { __typename } } }
    }
  }
}`;

const REVIEW_DECISION = {
	APPROVED: "approved",
	CHANGES_REQUESTED: "changes_requested",
};

export async function fetchPRState(github, pr) {
	const data = await github.graphql(PR_QUERY, {
		owner: pr.owner,
		repo: pr.repo,
		num: pr.num,
	});
	const p = FatalError.required(
		data.repository?.pullRequest,
		`PR ${pr.owner}/${pr.repo}#${pr.num} not found`,
	);
	return {
		merged: p.merged,
		closed: p.closed,
		reviewDecision: REVIEW_DECISION[p.reviewDecision] ?? null,
		hasUserComment: p.reviews.nodes.some((r) => r.author?.__typename !== "Bot"),
	};
}

export function prContext(payload) {
	const pr = payload.pull_request;
	const owner = pr?.base?.repo?.owner?.login;
	const repo = pr?.base?.repo?.name;
	const num = pr?.number;
	if (!owner || !repo || !Number.isFinite(num)) return null;
	return { owner, repo, num };
}

export function readJob() {
	// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
	const input = (name) =>
		(process.env[`INPUT_${name.toUpperCase()}`] || "").trim();

	const eventPath = FatalError.required(
		process.env.GITHUB_EVENT_PATH,
		"GITHUB_EVENT_PATH not set; not running inside GitHub Actions",
	);
	const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

	const entries = Object.keys(STATUS_PREDICATES)
		.map((k) => [k, input(`emoji-${k}`)])
		.filter(([, v]) => v);
	if (entries.length === 0) return null;
	const cfg = Object.fromEntries(entries);

	const slackToken = input("slack-token");
	if (!slackToken) {
		// Fork PRs run with empty secrets; that's expected, not a misconfig.
		if (payload.pull_request?.head?.repo?.fork) return null;
		throw new FatalError("slack-token is missing; set the SLACK_TOKEN secret");
	}

	const githubToken = FatalError.required(
		input("github-token"),
		"github-token is missing; the workflow's GITHUB_TOKEN should default it",
	);

	const pr = FatalError.required(
		prContext(payload),
		"could not derive PR context from payload",
	);

	return {
		slackToken,
		githubToken,
		cfg,
		pr,
		prKey: `${pr.owner}/${pr.repo}#${pr.num}`,
	};
}
