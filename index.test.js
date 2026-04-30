import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	deriveStatus,
	discoverMatches,
	FatalError,
	fetchBotUserId,
	fetchChannels,
	Memo,
	matchesPullUrl,
	prContext,
	Reactor,
	SlackClient,
	tokenizeAngles,
	urlsFromMessage,
} from "./index.js";

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

// ---------------------------------------------------------------- matchesPullUrl

test("matchesPullUrl: accepts the canonical PR URL with or without query/fragment", () => {
	const pr = { owner: "octo", repo: "hello", num: 123 };
	const m = (u) => matchesPullUrl(pr, u);
	assert.equal(m("https://github.com/octo/hello/pull/123"), true);
	assert.equal(
		m("https://github.com/octo/hello/pull/123?diff=split#discussion"),
		true,
	);
});

test("matchesPullUrl: rejects everything else", () => {
	const pr = { owner: "octo", repo: "hello", num: 123 };
	const m = (u) => matchesPullUrl(pr, u);
	// /pull/1234 is the substring trap a naive includes() would hit.
	assert.equal(m("https://github.com/octo/hello/pull/1234"), false);
	// nested path under the PR
	assert.equal(m("https://github.com/octo/hello/pull/123/files"), false);
	// different host
	assert.equal(m("https://gitlab.com/octo/hello/pull/123"), false);
	// different repo
	assert.equal(m("https://github.com/octo/other/pull/123"), false);
	// unparseable / empty
	assert.equal(m("not a url"), false);
	assert.equal(m(""), false);
});

// ---------------------------------------------------------------- tokenizeAngles

test("tokenizeAngles: bare URL in <…>", () => {
	assert.deepEqual(
		tokenizeAngles("see <https://github.com/o/r/pull/1> please"),
		["https://github.com/o/r/pull/1"],
	);
});

test("tokenizeAngles: |label suffix is stripped", () => {
	assert.deepEqual(
		tokenizeAngles("here: <https://github.com/o/r/pull/1|PR #1>"),
		["https://github.com/o/r/pull/1"],
	);
});

test("tokenizeAngles: multiple bare angles in one string", () => {
	assert.deepEqual(tokenizeAngles("<https://a> and <https://b>"), [
		"https://a",
		"https://b",
	]);
});

test("tokenizeAngles: degenerate inputs return [] without throwing or hanging", () => {
	assert.deepEqual(tokenizeAngles(""), []);
	assert.deepEqual(tokenizeAngles("no angles here"), []);
	// Unbalanced `<` without `>` would infinite-loop without the right guard.
	assert.deepEqual(tokenizeAngles("foo < bar"), []);
});

// ---------------------------------------------------------------- urlsFromMessage

test("urlsFromMessage: extracts from text <…>", () => {
	const urls = urlsFromMessage({
		text: "check <https://github.com/o/r/pull/1>",
	});
	assert.ok(urls.includes("https://github.com/o/r/pull/1"));
});

test("urlsFromMessage: extracts from attachments.title_link and from_url", () => {
	const urls = urlsFromMessage({
		attachments: [
			{
				title_link: "https://github.com/o/r/pull/2",
				from_url: "https://github.com/o/r/pull/2",
			},
		],
	});
	assert.ok(urls.includes("https://github.com/o/r/pull/2"));
});

test("urlsFromMessage: extracts from nested blocks (rich_text link element)", () => {
	// GitHub's official Slack app posts PR URLs in blocks, not text.
	const urls = urlsFromMessage({
		blocks: [
			{
				type: "rich_text",
				elements: [
					{
						type: "rich_text_section",
						elements: [{ type: "link", url: "https://github.com/o/r/pull/3" }],
					},
				],
			},
		],
	});
	assert.ok(urls.includes("https://github.com/o/r/pull/3"));
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
	const slack = new SlackClient({ token: "xoxb", fetch: impl, paceMs: 0 });
	return { slack, calls };
};

// Build a Reactor seeded with one cached match so run() skips discovery
// and goes straight into the reaction loop — that's the surface these tests
// exercise. Returns the prMatches handle too so tests can observe whether
// the entry was pruned (stale-match errors) or kept (tolerated/success).
const setupReactor = ({ slack, job = {}, botUserId = null }) => {
	const memo = new Memo();
	if (botUserId) memo.set("botUserId", botUserId);
	const prKey = "o/r#1";
	const prMatches = new Memo();
	prMatches.set(prKey, [{ channel: "C1", ts: "1.0" }]);
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
			pr: { owner: "o", repo: "r", num: 1 },
			...job,
		},
	});
	return { reactor, prMatches, prKey };
};

// ---------------------------------------------------------------- slackCall

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

test("slack.call: non-rate-limit errors are returned without retry", async () => {
	const { slack, calls } = slackFor({
		"reactions.add": [
			{ status: 200, body: { ok: false, error: "already_reacted" } },
		],
	});
	const res = await slack.call("reactions.add", {
		channel: "C1",
		timestamp: "1.0",
		name: "eyes",
	});
	assert.equal(res.error, "already_reacted");
	assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- fetchChannels

test("fetchChannels: paginates conversations.list and filters to is_member", async () => {
	const { slack, calls } = slackFor({
		"conversations.list": [
			{
				body: {
					ok: true,
					channels: [
						{ id: "C1", name: "general", is_member: true },
						{ id: "C2", name: "random", is_member: false },
					],
					response_metadata: { next_cursor: "cursor-page-2" },
				},
			},
			{
				body: {
					ok: true,
					channels: [
						{ id: "C3", name: "engineering", is_member: true },
						{ id: "C4", name: "lurkers", is_member: false },
					],
					response_metadata: { next_cursor: "" },
				},
			},
		],
	});
	const channels = await fetchChannels(slack);
	assert.deepEqual(
		channels.map((c) => c.id),
		["C1", "C3"],
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].params.cursor, "cursor-page-2");
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

// ---------------------------------------------------------------- discoverMatches

test("discoverMatches: scans history of every member channel for the PR URL", async () => {
	const matchingMsg = {
		ts: "1.001",
		text: "see <https://github.com/octo/hello/pull/42>",
	};
	const noisyMsg = { ts: "1.002", text: "unrelated chat" };
	const { slack, calls } = slackFor({
		"conversations.history": [
			{
				body: { ok: true, messages: [matchingMsg, noisyMsg], has_more: false },
			},
			{ body: { ok: true, messages: [noisyMsg], has_more: false } },
		],
	});
	const channels = [
		{ id: "C1", name: "a" },
		{ id: "C2", name: "b" },
	];
	const matches = await discoverMatches(
		slack,
		{ owner: "octo", repo: "hello", num: 42 },
		channels,
	);
	assert.deepEqual(matches, [{ channel: "C1", ts: "1.001" }]);
	assert.equal(calls.length, 2);
	assert.ok(parseInt(calls[0].params.oldest, 10) > 0);
});

test("discoverMatches: respects 100-channel cap", async () => {
	const channels = Array.from({ length: 150 }, (_, i) => ({
		id: `C${i}`,
		name: `c${i}`,
	}));
	const { slack, calls } = slackFor({
		"conversations.history": Array.from({ length: 100 }, () => ({
			body: { ok: true, messages: [], has_more: false },
		})),
	});
	await discoverMatches(slack, { owner: "o", repo: "r", num: 1 }, channels);
	assert.equal(calls.length, 100);
});

test("discoverMatches: paginates conversations.history up to 3 pages, then stops", async () => {
	const page = (cursor, has_more) => ({
		body: {
			ok: true,
			messages: [{ ts: "1.0", text: "noise" }],
			has_more,
			response_metadata: { next_cursor: cursor },
		},
	});
	const { slack, calls } = slackFor({
		"conversations.history": [
			page("p2", true),
			page("p3", true),
			page("p4", true),
			page("", false),
		],
	});
	await discoverMatches(slack, { owner: "o", repo: "r", num: 1 }, [
		{ id: "C1", name: "x" },
	]);
	assert.equal(calls.length, 3);
});

test("discoverMatches: extracts PR URL from blocks even when text is empty", async () => {
	const msg = {
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
		"conversations.history": [
			{ body: { ok: true, messages: [msg], has_more: false } },
		],
	});
	const matches = await discoverMatches(
		slack,
		{ owner: "octo", repo: "hello", num: 42 },
		[{ id: "C1", name: "x" }],
	);
	assert.deepEqual(matches, [{ channel: "C1", ts: "1.5" }]);
});

// ---------------------------------------------------------------- fetchBotUserId

test("fetchBotUserId: throws FatalError on invalid_auth (so caller can clean-exit)", async () => {
	const { slack } = slackFor({
		"auth.test": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	await assert.rejects(
		fetchBotUserId(slack),
		(e) => e instanceof FatalError && /invalid_auth/.test(e.message),
	);
});

// ---------------------------------------------------------------- Reactor.run (flip cleanup)

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
