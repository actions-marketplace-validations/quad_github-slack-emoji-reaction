// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Spawn `node index.js` the way GHA does: GITHUB_EVENT_PATH points at the
// payload, INPUT_* carry the action inputs (note GHA preserves hyphens in
// input names — INPUT_EMOJI-CLOSED is correct, not INPUT_EMOJI_CLOSED). With
// a fake GITHUB_TOKEN the action reaches GitHub for PR state, gets 401, and
// the top-level catch prints the message and exits 1. That round-trip is
// the wiring this test guards.

test("spawn: pull_request closed reaches GitHub and exits with auth error", () => {
	const repoRoot = `${import.meta.dirname}/..`;
	const r = spawnSync(process.execPath, ["src/index.js"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_EVENT_PATH: `${import.meta.dirname}/fixtures/upstream/pull_request/closed.payload.json`,
			"INPUT_GITHUB-TOKEN": "ghs_fake-token-for-integration-tests",
			"INPUT_SLACK-TOKEN": "xoxb-fake-token-for-integration-tests",
			"INPUT_EMOJI-CLOSED": "x",
		},
	});
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /::error::.*GitHub graphql failed: 401/);
});
