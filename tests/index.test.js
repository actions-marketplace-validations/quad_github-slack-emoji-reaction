// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CacheClient } from "../src/cache.js";
import { FatalError } from "../src/errors.js";
import { GitHubClient } from "../src/github.js";
import { Memo } from "../src/memo.js";
import { applyReactions } from "../src/pipeline/apply-reactions.js";
import { findMatches } from "../src/pipeline/find-matches.js";
import { desiredEmojis, fetchPRState, prContext } from "../src/pipeline/job.js";
import { SlackClient } from "../src/slack.js";

// ============================================================ static helpers

// Authoritative payloads vendored from octokit/webhooks; see fixtures/README.md.
// Parsed once per file, structuredClone'd at each call so tests can mutate freely.
const fixtureCache = new Map();
const upstream = (rel) => {
	if (!fixtureCache.has(rel)) {
		const p = path.join(import.meta.dirname, "fixtures", "upstream", rel);
		fixtureCache.set(rel, JSON.parse(fs.readFileSync(p, "utf8")));
	}
	return structuredClone(fixtureCache.get(rel));
};

// ---------------------------------------------------------------- desiredEmojis

const FULL_CFG = {
	approved: "white_check_mark",
	"changes-requested": "warning",
	commented: "speech_balloon",
	merged: "rocket",
	closed: "x",
};

test("desiredEmojis: merged + approved + hasUserComment → {merged, approved, commented}", () => {
	const set = desiredEmojis(
		{
			merged: true,
			closed: true,
			reviewDecision: "approved",
			hasUserComment: true,
		},
		FULL_CFG,
	);
	assert.deepEqual(
		[...set].sort(),
		["rocket", "speech_balloon", "white_check_mark"].sort(),
	);
});

test("desiredEmojis: changes_requested + closed-not-merged → {changes-requested, closed}", () => {
	const set = desiredEmojis(
		{
			merged: false,
			closed: true,
			reviewDecision: "changes_requested",
			hasUserComment: false,
		},
		FULL_CFG,
	);
	assert.deepEqual([...set].sort(), ["warning", "x"].sort());
});

test('desiredEmojis: cfg.approved="" omits the approved emoji even when reviewDecision=approved', () => {
	const set = desiredEmojis(
		{
			merged: false,
			closed: false,
			reviewDecision: "approved",
			hasUserComment: false,
		},
		{ ...FULL_CFG, approved: "" },
	);
	assert.equal(set.size, 0);
});

test("desiredEmojis: empty state → empty set", () => {
	const set = desiredEmojis(
		{
			merged: false,
			closed: false,
			reviewDecision: null,
			hasUserComment: false,
		},
		FULL_CFG,
	);
	assert.equal(set.size, 0);
});

// ---------------------------------------------------------------- fetchPRState

test("fetchPRState: parses GraphQL pullRequest into reconciliation state", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, opts) => {
		calls.push({ url: String(url), body: JSON.parse(opts.body) });
		return {
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					repository: {
						pullRequest: {
							merged: true,
							closed: true,
							reviewDecision: "APPROVED",
							reviews: {
								nodes: [
									{ author: { __typename: "User" } },
									{ author: { __typename: "Bot" } },
								],
							},
						},
					},
				},
			}),
		};
	});
	const github = new GitHubClient("ghs_token", new AbortController().signal);
	const state = await fetchPRState(github, {
		owner: "octo",
		repo: "hello",
		num: 42,
	});
	assert.deepEqual(state, {
		merged: true,
		closed: true,
		reviewDecision: "approved",
		hasUserComment: true,
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /\/graphql$/);
	assert.deepEqual(calls[0].body.variables, {
		owner: "octo",
		repo: "hello",
		num: 42,
	});
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
		const method = String(url).replace("https://slack.com/api/", "");
		const params = Object.fromEntries(new URLSearchParams(opts.body || ""));
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

// Each test installs its own fetch shim via t.mock.method, which restores
// globalThis.fetch automatically at test end — no manual cleanup needed.
const slackFor = (t, scripts) => {
	const { impl, calls } = shimFetch(scripts);
	t.mock.method(globalThis, "fetch", impl);
	const slack = new SlackClient("xoxb", new AbortController().signal);
	return { slack, calls };
};

// Wires up findMatches+applyReactions for end-to-end run tests. By default
// seeds a cached match so the run skips discovery — callers exercising the
// discovery path pass `cached: null`. Returns prMatches so tests can observe
// outcomes.
const setupRun = ({
	slack,
	job = {},
	botUserId = "U0BOT",
	cached = [{ channel: "C1", ts: "1.0" }],
}) => {
	const memo = new Memo({});
	if (botUserId) memo.set("botUserId", botUserId);
	const prKey = "octo/hello#42";
	const prMatches = new Memo({});
	if (cached) prMatches.set(prKey, cached);
	const fullJob = {
		desired: new Set(["eyes"]),
		managed: new Set(["eyes"]),
		closesPR: false,
		prKey,
		pr: { owner: "octo", repo: "hello", num: 42 },
		...job,
	};
	const run = async () => {
		const matches = await findMatches(slack, memo, prMatches, fullJob);
		await applyReactions(slack, memo, prMatches, fullJob, matches);
	};
	return { run, prMatches, prKey };
};

// ---------------------------------------------------------------- SlackClient.call

test("slack.call: returns body verbatim on success", async (t) => {
	const { slack } = slackFor(t, {
		"auth.test": [{ body: { ok: true, user_id: "U0BOT" } }],
	});
	const res = await slack.call("auth.test");
	assert.deepEqual(res, { ok: true, user_id: "U0BOT" });
});

test("slack.call: 429 with Retry-After triggers a sleep+retry, then succeeds", async (t) => {
	const { slack, calls } = slackFor(t, {
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
	const res = await slack.call("auth.test");
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, true);
	assert.equal(calls.length, 2);
	assert.ok(
		elapsed >= 900,
		`expected ≥1s sleep on Retry-After, got ${elapsed}ms`,
	);
});

test("slack.call: 200 + ok:false + error=ratelimited is treated as rate-limit (Slack quirk)", async (t) => {
	const { slack, calls } = slackFor(t, {
		"conversations.history": [
			{
				status: 200,
				headers: { "retry-after": "1" },
				body: { ok: false, error: "ratelimited" },
			},
			{ body: { ok: true, messages: [] } },
		],
	});
	const res = await slack.call("conversations.history", {
		params: { channel: "C1" },
	});
	assert.equal(res.ok, true);
	assert.equal(calls.length, 2);
});

test("slack.call: gives up after 2 retries and returns the last 429 body", async (t) => {
	const ratelimited = {
		status: 429,
		headers: { "retry-after": "1" },
		body: { ok: false, error: "ratelimited" },
	};
	const { slack, calls } = slackFor(t, {
		"auth.test": [ratelimited, ratelimited, ratelimited],
	});
	const res = await slack.call("auth.test");
	assert.equal(res.ok, false);
	assert.equal(res.error, "ratelimited");
	assert.equal(calls.length, 3);
});

test("slack.call: invalid_auth response is thrown as FatalError", async (t) => {
	const { slack } = slackFor(t, {
		"auth.test": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	await assert.rejects(
		slack.call("auth.test"),
		(e) => e instanceof FatalError && /invalid_auth/.test(e.message),
	);
});

// ---------------------------------------------------------------- Memo

test("Memo.getOrSet: caches first call, skips fetcher on subsequent calls within TTL", async () => {
	const memo = new Memo({});
	let calls = 0;
	const fetcher = async () => ++calls;
	assert.equal(await memo.getOrSet("k", 60, fetcher), 1);
	assert.equal(await memo.getOrSet("k", 60, fetcher), 1);
	assert.equal(calls, 1);
});

test("Memo.getOrSet: refetches once the cell's age exceeds the TTL", async () => {
	// Seed a stale cell (refreshedAt 1h ago, TTL 60s).
	const stale = Math.floor(Date.now() / 1000) - 3600;
	const memo = new Memo({ k: { value: "old", refreshedAt: stale } });
	const result = await memo.getOrSet("k", 60, async () => "fresh");
	assert.equal(result, "fresh");
});

// ---------------------------------------------------------------- CacheClient

test("CacheClient: no-op when ACTIONS_RESULTS_URL is missing (outside GHA)", async () => {
	const orig = {
		url: process.env.ACTIONS_RESULTS_URL,
		token: process.env.ACTIONS_RUNTIME_TOKEN,
		gha: process.env.GITHUB_ACTIONS,
	};
	delete process.env.ACTIONS_RESULTS_URL;
	delete process.env.ACTIONS_RUNTIME_TOKEN;
	delete process.env.GITHUB_ACTIONS;
	try {
		const cache = new CacheClient();
		assert.equal(
			await cache.restore(new AbortController().signal),
			null,
			"restore should return null when cache is unavailable",
		);
		await cache.save({ memo: {}, prMatches: {} });
	} finally {
		if (orig.url !== undefined) process.env.ACTIONS_RESULTS_URL = orig.url;
		if (orig.token !== undefined)
			process.env.ACTIONS_RUNTIME_TOKEN = orig.token;
		if (orig.gha !== undefined) process.env.GITHUB_ACTIONS = orig.gha;
	}
});

test("CacheClient: warns when cache is unavailable inside GHA (misconfig)", async () => {
	const orig = {
		url: process.env.ACTIONS_RESULTS_URL,
		token: process.env.ACTIONS_RUNTIME_TOKEN,
		gha: process.env.GITHUB_ACTIONS,
		log: console.log,
	};
	delete process.env.ACTIONS_RESULTS_URL;
	delete process.env.ACTIONS_RUNTIME_TOKEN;
	process.env.GITHUB_ACTIONS = "true";
	const lines = [];
	console.log = (msg) => lines.push(msg);
	try {
		new CacheClient();
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^::warning::.*cache unavailable/i);
	} finally {
		console.log = orig.log;
		if (orig.url !== undefined) process.env.ACTIONS_RESULTS_URL = orig.url;
		if (orig.token !== undefined)
			process.env.ACTIONS_RUNTIME_TOKEN = orig.token;
		if (orig.gha !== undefined) process.env.GITHUB_ACTIONS = orig.gha;
		else delete process.env.GITHUB_ACTIONS;
	}
});

// ---------------------------------------------------------------- applyReactions (reconciliation, with cached match)

// Helper: a reactions.get response carrying a single reaction.
const reactionsGetWith = (reactions) => ({
	body: { ok: true, message: { reactions } },
});

test("applyReactions: bot already has the desired emoji → no add or remove", async (t) => {
	const { slack, calls } = slackFor(t, {
		"reactions.get": [
			reactionsGetWith([{ name: "eyes", users: ["U0BOT"], count: 1 }]),
		],
	});
	const { run } = setupRun({ slack });
	await run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get"],
	);
});

test("applyReactions: bot has obsolete (managed) emoji + desired wants a different one → remove old, add new", async (t) => {
	const { slack, calls } = slackFor(t, {
		"reactions.get": [
			reactionsGetWith([
				{ name: "warning", users: ["U0BOT", "U1HUMAN"], count: 2 },
			]),
		],
		"reactions.remove": [{ body: { ok: true } }],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { run } = setupRun({
		slack,
		job: {
			desired: new Set(["white_check_mark"]),
			managed: new Set(["white_check_mark", "warning"]),
		},
	});
	await run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.remove", "reactions.add"],
	);
});

test("applyReactions: desired empty + bot owns a managed reaction → remove it", async (t) => {
	const { slack, calls } = slackFor(t, {
		"reactions.get": [
			reactionsGetWith([{ name: "eyes", users: ["U0BOT"], count: 1 }]),
		],
		"reactions.remove": [{ body: { ok: true } }],
	});
	const { run } = setupRun({
		slack,
		job: { desired: new Set(), managed: new Set(["eyes"]) },
	});
	await run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.remove"],
	);
});

test("applyReactions: desired empty + only a human owns the managed reaction → leave it alone", async (t) => {
	const { slack, calls } = slackFor(t, {
		"reactions.get": [
			reactionsGetWith([{ name: "eyes", users: ["U1HUMAN"], count: 1 }]),
		],
	});
	const { run } = setupRun({
		slack,
		job: { desired: new Set(), managed: new Set(["eyes"]) },
	});
	await run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get"],
	);
});

test("applyReactions: desired={approved, merged}, bot has approved → adds merged only (multi-emoji partial state)", async (t) => {
	const { slack, calls } = slackFor(t, {
		"reactions.get": [
			reactionsGetWith([
				{ name: "white_check_mark", users: ["U0BOT"], count: 1 },
			]),
		],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { run } = setupRun({
		slack,
		job: {
			desired: new Set(["white_check_mark", "rocket"]),
			managed: new Set(["white_check_mark", "rocket"]),
		},
	});
	await run();
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.add"],
	);
	assert.equal(
		calls.find((c) => c.method === "reactions.add").params.name,
		"rocket",
	);
});

// ---------------------------------------------------------------- applyReactions (prMatches lifecycle)

test("applyReactions: tolerated reaction errors (already_reacted) keep the match in cache", async (t) => {
	const { slack } = slackFor(t, {
		"reactions.get": [reactionsGetWith([])],
		"reactions.add": [{ body: { ok: false, error: "already_reacted" } }],
	});
	const { run, prMatches, prKey } = setupRun({
		slack,
		job: {
			desired: new Set(["large_purple_square"]),
			managed: new Set(["large_purple_square"]),
		},
	});
	await run();
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C1", ts: "1.0" }]);
});

test("applyReactions: stale-match errors (channel_not_found) prune the entry from cache", async (t) => {
	const { slack } = slackFor(t, {
		"reactions.get": [{ body: { ok: false, error: "channel_not_found" } }],
	});
	const { run, prMatches, prKey } = setupRun({ slack });
	await run();
	assert.equal(prMatches.get(prKey), undefined);
});

test("applyReactions: stale prune is persisted incrementally, surviving a later throw", async (t) => {
	// Two cached matches. First reactions.get says channel_not_found (prune);
	// second throws invalid_auth. Without incremental persist, the prune would
	// be lost when the throw short-circuits the final write.
	const { slack } = slackFor(t, {
		"reactions.get": [
			{ body: { ok: false, error: "channel_not_found" } },
			{ body: { ok: false, error: "invalid_auth" } },
		],
	});
	const { run, prMatches, prKey } = setupRun({
		slack,
		cached: [
			{ channel: "C1", ts: "1.0" },
			{ channel: "C2", ts: "2.0" },
		],
	});
	await assert.rejects(run(), (e) => e instanceof FatalError);
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C2", ts: "2.0" }]);
});

test("applyReactions: invalid_auth from Slack propagates as FatalError", async (t) => {
	const { slack } = slackFor(t, {
		"reactions.get": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	const { run } = setupRun({ slack });
	await assert.rejects(
		run(),
		(e) => e instanceof FatalError && /invalid_auth/.test(e.message),
	);
});

// ---------------------------------------------------------------- run (discovery, no cached match)

test("run: with no cached match, paginates channels.list (filtered to is_member) and scans history", async (t) => {
	const matchingMsg = {
		ts: "1.001",
		text: "see <https://github.com/octo/hello/pull/42>",
	};
	const { slack, calls } = slackFor(t, {
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
			{ body: { ok: true, messages: [matchingMsg], has_more: false } },
		],
		"reactions.get": [reactionsGetWith([]), reactionsGetWith([])],
		"reactions.add": [{ body: { ok: true } }, { body: { ok: true } }],
	});
	const { run, prMatches, prKey } = setupRun({
		slack,
		job: { desired: new Set(["x"]), managed: new Set(["x"]) },
		cached: null,
	});
	await run();
	// channels.list paginated to completion; both is_member channels (C1, C3
	// — not C2) scanned in some order (discoverMatches shuffles).
	assert.equal(
		calls.filter((c) => c.method === "conversations.list").length,
		2,
	);
	assert.deepEqual(
		new Set(
			calls
				.filter((c) => c.method === "conversations.history")
				.map((c) => c.params.channel),
		),
		new Set(["C1", "C3"]),
	);
	assert.deepEqual(
		new Set(prMatches.get(prKey).map((m) => m.channel)),
		new Set(["C1", "C3"]),
	);
});

test("run: discovery rejects /pull/123 ↔ /pull/1234 substring trap", async (t) => {
	const { slack } = slackFor(t, {
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
	const { run, prMatches, prKey } = setupRun({
		slack,
		job: { desired: new Set(["x"]), managed: new Set(["x"]) },
		cached: null,
	});
	await run();
	// No reactions.add (no match), no entry in cache (terminal-ish empty
	// → delete handled by the "non-terminal + nothing surviving" branch).
	assert.equal(prMatches.get(prKey), undefined);
});

test("run: discovery extracts PR URL from message blocks (not just text)", async (t) => {
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
	const { slack } = slackFor(t, {
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
		"reactions.get": [reactionsGetWith([])],
		"reactions.add": [{ body: { ok: true } }],
	});
	const { run, prMatches, prKey } = setupRun({
		slack,
		job: { desired: new Set(["x"]), managed: new Set(["x"]) },
		cached: null,
	});
	await run();
	assert.deepEqual(prMatches.get(prKey), [{ channel: "C1", ts: "1.5" }]);
});
