import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Drives nektos/act against a vendored event payload. Uses a fake bot
// token, so the action is expected to reach Slack auth and exit 1 with
// our AuthError message — that exact path is the "wiring works" signal
// we want (action.yml dispatch, INPUT_* injection, node24 actually
// starting, FatalError catch printing the message).
//
// Requires Docker + act on PATH.

test("act: pull_request closed reaches auth and exits with AuthError message", async () => {
	const out = await execFileP(
		"act",
		[
			"pull_request",
			"-W",
			".github/workflows/integration-act.yml",
			"-e",
			"fixtures/upstream/pull_request/closed.payload.json",
			"-s",
			"SLACK_TOKEN=xoxb-fake-token-for-integration-tests",
			"-P",
			"ubuntu-latest=catthehacker/ubuntu:act-latest",
		],
		{ cwd: import.meta.dirname },
		// act exits non-zero (the action throws AuthError); execFile rejects
		// on non-zero, so we catch and treat the rejection's stdout/stderr as
		// the result.
	).catch((e) => ({ stdout: e.stdout, stderr: e.stderr }));
	assert.match(
		out.stdout + out.stderr,
		/Slack auth error: invalid_auth/,
		out.stdout + out.stderr,
	);
});
