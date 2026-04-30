import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Spawn `node index.js` the way GHA does: GITHUB_EVENT_NAME +
// GITHUB_EVENT_PATH point at the payload, INPUT_* carry the action
// inputs (note GHA preserves hyphens in input names — INPUT_EMOJI-CLOSED
// is correct, not INPUT_EMOJI_CLOSED). With a fake token the action
// reaches Slack, AuthError fires, top-level catch prints the message
// and exits 1. That round-trip is the wiring this test guards.

test("spawn: pull_request closed reaches auth and exits with AuthError", async () => {
	const out = await execFileP(process.execPath, ["index.js"], {
		cwd: import.meta.dirname,
		env: {
			...process.env,
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_EVENT_PATH: `${import.meta.dirname}/fixtures/upstream/pull_request/closed.payload.json`,
			"INPUT_SLACK-TOKEN": "xoxb-fake-token-for-integration-tests",
			"INPUT_EMOJI-CLOSED": "x",
		},
	}).catch((e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
	assert.equal(out.code, 1, out.stdout + out.stderr);
	assert.match(out.stderr, /Slack auth error: invalid_auth/);
});
