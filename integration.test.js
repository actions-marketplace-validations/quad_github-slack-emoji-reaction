import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Spawn `node index.js` the way GHA does: GITHUB_EVENT_NAME +
// GITHUB_EVENT_PATH point at the payload, INPUT_* carry the action
// inputs (note GHA preserves hyphens in input names — INPUT_EMOJI-CLOSED
// is correct, not INPUT_EMOJI_CLOSED). With a fake token the action
// reaches Slack, AuthError fires, top-level catch prints the message
// and exits 1. That round-trip is the wiring this test guards.

test("spawn: pull_request closed reaches auth and exits with AuthError", () => {
	const r = spawnSync(process.execPath, ["index.js"], {
		cwd: import.meta.dirname,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_EVENT_PATH: `${import.meta.dirname}/fixtures/upstream/pull_request/closed.payload.json`,
			"INPUT_SLACK-TOKEN": "xoxb-fake-token-for-integration-tests",
			"INPUT_EMOJI-CLOSED": "x",
		},
	});
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /Slack auth error: invalid_auth/);
});
