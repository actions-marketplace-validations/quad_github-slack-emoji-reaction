import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FatalError } from "../src/errors.js";
import { deriveStatus, prContext, Reactor } from "../src/index.js";
import { Memo } from "../src/memo.js";
import { SlackClient } from "../src/slack.js";

// ============================================================ static helpers

// Authoritative payloads vendored from octokit/webhooks; see fixtures/SOURCE.md.
// Parsed once per file, structuredClone'd at each call so tests can mutate freely.
const fixtureCache = new Map();
const upstream = (rel) => {
	if (!fixtureCache.has(rel)) {
		const p = path.join(import.meta.dirname, "fixtures", "upstream", rel);
		fixtureCache.set(rel, JSON.parse(fs.readFileSync(p, "utf8")));
	}
	return structuredClone(fixtureCache.get(rel));
};

const variant = (rel, patch) => {
	const p = upstream(rel);
	for (const key of Object.keys(patch)) {
		const segs = key.split(".");
		const target = segs.slice(0, -1).reduce((o, k) => o[k], p);
		target[segs[segs.length - 1]] = patch[key];
	}
	return p;
};

// ---------------------------------------------------------------- deriveStatus

test("deriveStatus: pull_request_review submitted approved → approved", () => {
	const payload = variant("pull_request_review/submitted.payload.json", {
		"review.state": "approved",
	});
	assert.equal(deriveStatus("pull_request_review", payload), "approved");
});

test("deriveStatus: pull_request_review submitted changes_requested → changes-requested", () => {
	const payload = variant("pull_request_review/submitted.payload.json", {
		"review.state": "changes_requested",
	});
	assert.equal(
		deriveStatus("pull_request_review", payload),
		"changes-requested",
	);
});

test("deriveStatus: pull_request closed merged=true → merged", () => {
	const payload = variant("pull_request/closed.payload.json", {
		"pull_request.merged": true,
	});
	assert.equal(deriveStatus("pull_request", payload), "merged");
});

test("deriveStatus: pull_request closed merged=false → closed", () => {
	// Upstream closed.payload.json has pull_request.merged: false verbatim.
	assert.equal(
		deriveStatus("pull_request", upstream("pull_request/closed.payload.json")),
		"closed",
	);
});

test("deriveStatus: returns null for non-mapped events", () => {
	// commented reviews, dismissed reviews, opened PRs, and unrelated events.
	assert.equal(
		deriveStatus(
			"pull_request_review",
			upstream("pull_request_review/submitted.payload.json"),
		),
		null,
	);
	assert.equal(
		deriveStatus(
			"pull_request_review",
			upstream("pull_request_review/dismissed.payload.json"),
		),
		null,
	);
	assert.equal(
		deriveStatus("pull_request", upstream("pull_request/opened.payload.json")),
		null,
	);
	assert.equal(deriveStatus("issues", { action: "opened" }), null);
});

// ---------------------------------------------------------------- prContext

test("prContext: extracts owner/repo/num from authoritative payload", () => {
	const ctx = prContext(upstream("pull_request/opened.payload.json"));
	assert.deepEqual(ctx, {
		owner: "Codertocat",
		repo: "Hello-World",
		num: 2,
	});
});

test("prContext: returns null on incomplete payload", () => {
	// Missing structured fields (owner/repo/number).
	assert.equal(prContext({ pull_request: { html_url: "x" } }), null);
	// Missing pull_request entirely.
	assert.equal(prContext({}), null);
});

// ============================================================ fetch-shim suite

// Build a scripted fetch that pops a sequence of pre-canned responses keyed by
// Slack method name. Records every call in `calls` for assertions.
function shimFetch(scripts) {
	const calls = [];
	const queues = new Map();
	for (const [method, responses] of Object.entries(scripts)) {
		queues.set(method, [...responses]);
	}
	const impl = async (url, opts) => {
		const method = url.replace("https://slack.com/api/", "");
		const params = JSON.parse(opts.body || "{}");
		calls.push({ method, params });
		const queue = queues.get(method);
		if (!queue || queue.length === 0) {
			throw new Error(
				`shim: no scripted response for ${method} (call #${calls.length})`,
			);
		}
		const r = queue.shift();
		return {
			status: r.status ?? 200,
			ok: (r.status ?? 200) < 400,
			headers: new Headers(r.headers ?? {}),
			json: async () => r.body,
		};
	};
	return { impl, calls };
}

// Each test builds its own slack client over a scripted fetch shim — no
// shared module state to reset between tests.
const slackFor = (scripts) => {
	const { impl, calls } = shimFetch(scripts);
	const slack = new SlackClient({ token: "xoxb", fetch: impl });
	return { slack, calls };
};

// Build a Reactor for run() tests. By default seeds a cached match so run()
// skips discovery — callers exercising the discovery path pass `cached: null`.
// Returns the prMatches handle so tests can observe retain/prune outcomes.
const setupReactor = ({
	slack,
	job = {},
	botUserId = null,
	cached = [{ channel: "C1", ts: "1.0" }],
}) => {
	const memo = new Memo();
	if (botUserId) memo.set("botUserId", botUserId);
	const prKey = "octo/hello#42";
	const prMatches = new Memo();
	if (cached) prMatches.set(prKey, cached);
	const reactor = new Reactor({
		slack,
		memo,
		prMatches,
		job: {
			addEmoji: "eyes",
			removeEmoji: "",
			isRerun: false,
			closesPR: false,
			prKey,
			pr: { owner: "octo", repo: "hello", num: 42 },
			...job,
		},
	});
	return { reactor, prMatches, prKey };
};

// ---------------------------------------------------------------- SlackClient.call

test("slack.call: returns body verbatim on success", async () => {
	const { slack } = slackFor({
		"auth.test": [{ body: { ok: true, user_id: "U0BOT" } }],
	});
	const res = await slack.call("auth.test", {});
	assert.deepEqual(res, { ok: true, user_id: "U0BOT" });
});

test("slack.call: 429 with Retry-After triggers a sleep+retry, then succeeds", async () => {
	const { slack, calls } = slackFor({
		"auth.test": [
			{
				status: 429,
				headers: { "retry-after": "1" },
				body: { ok: false, error: "ratelimited" },
			},
			{ body: { ok: true, user_id: "U0BOT" } },
		],
	});
	const t0 = Date.now();
	const res = await slack.call("auth.test", {});
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, true);
	assert.equal(calls.length, 2);
	assert.ok(
		elapsed >= 900,
		`expected ≥1s sleep on Retry-After, got ${elapsed}ms`,
	);
});

test("slack.call: 200 + ok:false + error=ratelimited is treated as rate-limit (Slack quirk)", async () => {
	const { slack, calls } = slackFor({
		"conversations.history": [
			{
				status: 200,
				headers: { "retry-after": "1" },
				body: { ok: false, error: "ratelimited" },
			},
			{ body: { ok: true, messages: [] } },
		],
	});
	const res = await slack.call("conversations.history", { channel: "C1" });
	assert.equal(res.ok, true);
	assert.equal(calls.length, 2);
});

test("slack.call: gives up after 3 retries and returns the last 429 body", async () => {
	const ratelimited = {
		status: 429,
		headers: { "retry-after": "1" },
		body: { ok: false, error: "ratelimited" },
	};
	const { slack, calls } = slackFor({
		"auth.test": [ratelimited, ratelimited, ratelimited, ratelimited],
	});
	const res = await slack.call("auth.test", {});
	assert.equal(res.ok, false);
	assert.equal(res.error, "ratelimited");
	assert.equal(calls.length, 4);
});

test("slack.call: invalid_auth response is thrown as FatalError", async () => {
	const { slack } = slackFor({
		"auth.test": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	await assert.rejects(
		slack.call("auth.test", {}),
		(e) => e instanceof FatalError && /invalid_auth/.test(e.message),
	);
});

// ---------------------------------------------------------------- Memo

test("Memo.ensure: caches first call, skips fetcher on subsequent calls within TTL", async () => {
	const memo = new Memo();
	let calls = 0;
	const fetcher = async () => ++calls;
	assert.equal(await memo.ensure("k", 60, fetcher), 1);
	assert.equal(await memo.ensure("k", 60, fetcher), 1);
	assert.equal(calls, 1);
});

test("Memo.ensure: refetches once the cell's age exceeds the TTL", async () => {
	// Seed a stale cell (refreshedAt 1h ago, TTL 60s).
	const stale = Math.floor(Date.now() / 1000) - 3600;
	const memo = new Memo({ k: { value: "old", refreshedAt: stale } });
	const result = await memo.ensure("k", 60, async () => "fresh");
	assert.equal(result, "fresh");
});

// ---------------------------------------------------------------- Reactor.run (flip cleanup, with cached match)

test("Reactor.run: approved with our bot owning a stale changes-requested removes the warning, then adds approved", async () => {
	const { slack, calls } = slackFor({
		"reactions.get": [
			{
				body: {
					ok: true,
					message: {
						reactions: [
							{ name: "warning", users: ["U0BOT", "U1HUMAN"], count: 2 },
						],
					},
				},
			},
		],
		"reactions.remove": [{ body: { ok: true } }],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { reactor } = setupReactor({
		slack,
		job: { addEmoji: "white_check_mark", removeEmoji: "warning" },
		botUserId: "U0BOT",
	});
	await reactor.run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.remove", "reactions.add"],
	);
});

test("Reactor.run: approved without our bot in the warning users array does NOT remove someone else’s warning", async () => {
	const { slack, calls } = slackFor({
		"reactions.get": [
			{
				body: {
					ok: true,
					message: {
						reactions: [{ name: "warning", users: ["U1HUMAN"], count: 1 }],
					},
				},
			},
		],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { reactor } = setupReactor({
		slack,
		job: { addEmoji: "white_check_mark", removeEmoji: "warning" },
		botUserId: "U0BOT",
	});
	await reactor.run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.add"],
	);
});

test("Reactor.run: when isRerun=true, skips the entire flip-cleanup branch (re-run safety)", async () => {
	const { slack, calls } = slackFor({
		"reactions.add": [{ body: { ok: true } }],
	});
	const { reactor } = setupReactor({
		slack,
		job: {
			addEmoji: "white_check_mark",
			removeEmoji: "warning",
			isRerun: true,
		},
		botUserId: "U0BOT",
	});
	await reactor.run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.add"],
	);
});

test("Reactor.run: tolerated reaction errors (already_reacted) keep the match in cache", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "already_reacted" } }],
	});
	const { reactor, prMatches, prKey } = setupReactor({
		slack,
		job: { addEmoji: "large_purple_square" },
	});
	await reactor.run();
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C1", ts: "1.0" }]);
});

test("Reactor.run: stale-match errors (channel_not_found) prune the entry from cache", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "channel_not_found" } }],
	});
	const { reactor, prMatches, prKey } = setupReactor({
		slack,
		job: { addEmoji: "large_purple_square" },
	});
	await reactor.run();
	assert.equal(prMatches.get(prKey), undefined);
});

test("Reactor.run: invalid_auth on reactions.add propagates as FatalError", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	const { reactor } = setupReactor({ slack });
	await assert.rejects(
		reactor.run(),
		(e) => e instanceof FatalError && /invalid_auth/.test(e.message),
	);
});

// ---------------------------------------------------------------- Reactor.run (discovery, no cached match)

test("Reactor.run: with no cached match, paginates channels.list (filtered to is_member) and scans history", async () => {
	const matchingMsg = {
		ts: "1.001",
		text: "see <https://github.com/octo/hello/pull/42>",
	};
	const { slack, calls } = slackFor({
		"conversations.list": [
			{
				body: {
					ok: true,
					channels: [
						{ id: "C1", name: "general", is_member: true },
						{ id: "C2", name: "lurkers", is_member: false },
					],
					response_metadata: { next_cursor: "page2" },
				},
			},
			{
				body: {
					ok: true,
					channels: [{ id: "C3", name: "engineering", is_member: true }],
					response_metadata: { next_cursor: "" },
				},
			},
		],
		"conversations.history": [
			{ body: { ok: true, messages: [matchingMsg], has_more: false } },
			{ body: { ok: true, messages: [], has_more: false } },
		],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { reactor, prMatches, prKey } = setupReactor({
		slack,
		job: { addEmoji: "x" },
		cached: null,
	});
	await reactor.run();
	// channels.list paginated to completion, history scanned for both
	// is_member channels (C1, C3 — not C2), reaction added on the matching
	// message in C1, both matches stored in prMatches.
	assert.equal(
		calls.filter((c) => c.method === "conversations.list").length,
		2,
	);
	assert.deepEqual(
		calls
			.filter((c) => c.method === "conversations.history")
			.map((c) => c.params.channel),
		["C1", "C3"],
	);
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C1", ts: "1.001" }]);
});

test("Reactor.run: discovery rejects /pull/123 ↔ /pull/1234 substring trap", async () => {
	const { slack } = slackFor({
		"conversations.list": [
			{
				body: {
					ok: true,
					channels: [{ id: "C1", name: "general", is_member: true }],
					response_metadata: { next_cursor: "" },
				},
			},
		],
		"conversations.history": [
			{
				body: {
					ok: true,
					messages: [
						{
							ts: "1.0",
							text: "see <https://github.com/octo/hello/pull/1234>",
						},
					],
					has_more: false,
				},
			},
		],
	});
	const { reactor, prMatches, prKey } = setupReactor({
		slack,
		job: { addEmoji: "x" },
		cached: null,
	});
	await reactor.run();
	// No reactions.add (no match), no entry in cache (terminal-ish empty
	// → delete handled by the "non-terminal + nothing surviving" branch).
	assert.equal(prMatches.get(prKey), undefined);
});

test("Reactor.run: discovery extracts PR URL from message blocks (not just text)", async () => {
	const msgWithBlocks = {
		ts: "1.5",
		blocks: [
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: [
							{ type: "link", url: "https://github.com/octo/hello/pull/42" },
						],
					},
				],
			},
		],
	};
	const { slack } = slackFor({
		"conversations.list": [
			{
				body: {
					ok: true,
					channels: [{ id: "C1", name: "general", is_member: true }],
					response_metadata: { next_cursor: "" },
				},
			},
		],
		"conversations.history": [
			{ body: { ok: true, messages: [msgWithBlocks], has_more: false } },
		],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { reactor, prMatches, prKey } = setupReactor({
		slack,
		job: { addEmoji: "x" },
		cached: null,
	});
	await reactor.run();
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C1", ts: "1.5" }]);
});
