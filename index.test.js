import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	AuthError,
	deriveStatus,
	discoverMatches,
	ensureBotUserId,
	ensureChannels,
	matchesPullUrl,
	prContext,
	reactToMatch,
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

test("deriveStatus: pull_request_review submitted commented → null (deliberately ignored)", () => {
	// Upstream submitted.payload.json has review.state: "commented" verbatim.
	assert.equal(
		deriveStatus(
			"pull_request_review",
			upstream("pull_request_review/submitted.payload.json"),
		),
		null,
	);
});

test("deriveStatus: pull_request_review dismissed → null (deliberately ignored)", () => {
	assert.equal(
		deriveStatus(
			"pull_request_review",
			upstream("pull_request_review/dismissed.payload.json"),
		),
		null,
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

test("deriveStatus: pull_request opened → null (no review-requested mapping)", () => {
	assert.equal(
		deriveStatus("pull_request", upstream("pull_request/opened.payload.json")),
		null,
	);
});

test("deriveStatus: unknown event → null", () => {
	assert.equal(deriveStatus("issues", { action: "opened" }), null);
});

// ---------------------------------------------------------------- prContext

test("prContext: extracts owner/repo/num from authoritative payload", () => {
	const ctx = prContext(upstream("pull_request/opened.payload.json"));
	assert.deepEqual(ctx, {
		owner: "Codertocat",
		repo: "Hello-World",
		num: 2,
		prUrl: "https://github.com/Codertocat/Hello-World/pull/2",
	});
});

test("prContext: rejects payload with missing structured fields", () => {
	assert.equal(prContext({ pull_request: { html_url: "x" } }), null);
});

test("prContext: rejects missing pull_request", () => {
	assert.equal(prContext({}), null);
});

// ---------------------------------------------------------------- matchesPullUrl

test("matchesPullUrl: exact match", () => {
	assert.equal(
		matchesPullUrl(
			"https://github.com/octo/hello/pull/123",
			"octo",
			"hello",
			123,
		),
		true,
	);
});

// Real boundary: substring '/pull/123' is a prefix of '/pull/1234'. This is the
// case naive String.includes() / pathname.startsWith() implementations get wrong.
test("matchesPullUrl: /pull/1234 does NOT match /pull/123 (substring trap)", () => {
	assert.equal(
		matchesPullUrl(
			"https://github.com/octo/hello/pull/1234",
			"octo",
			"hello",
			123,
		),
		false,
	);
});

test("matchesPullUrl: nested path under PR (e.g. /files) does NOT match", () => {
	assert.equal(
		matchesPullUrl(
			"https://github.com/octo/hello/pull/123/files",
			"octo",
			"hello",
			123,
		),
		false,
	);
});

test("matchesPullUrl: rejects different host", () => {
	assert.equal(
		matchesPullUrl(
			"https://gitlab.com/octo/hello/pull/123",
			"octo",
			"hello",
			123,
		),
		false,
	);
});

test("matchesPullUrl: rejects different repo", () => {
	assert.equal(
		matchesPullUrl(
			"https://github.com/octo/other/pull/123",
			"octo",
			"hello",
			123,
		),
		false,
	);
});

test("matchesPullUrl: garbage / empty candidates do not throw", () => {
	assert.equal(matchesPullUrl("not a url", "octo", "hello", 123), false);
	assert.equal(matchesPullUrl("", "octo", "hello", 123), false);
});

test("matchesPullUrl: query string and fragment do not affect path match", () => {
	assert.equal(
		matchesPullUrl(
			"https://github.com/octo/hello/pull/123?diff=split#discussion",
			"octo",
			"hello",
			123,
		),
		true,
	);
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

const ctx = (overrides) => ({
	status: "merged",
	emoji: "eyes",
	oppositeEmoji: null,
	botUserId: null,
	isRerun: false,
	...overrides,
});

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

// ---------------------------------------------------------------- ensureChannels

test("ensureChannels: paginates conversations.list and filters to is_member", async () => {
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
	const state = {};
	const channels = await ensureChannels(state, slack);
	assert.deepEqual(
		channels.map((c) => c.id),
		["C1", "C3"],
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].params.cursor, "cursor-page-2");
});

test("ensureChannels: returns cached list when within TTL", async () => {
	const { slack, calls } = slackFor({ "conversations.list": [] });
	const state = {
		channels: [{ id: "C1", name: "general" }],
		channelsRefreshedAt: Math.floor(Date.now() / 1000) - 60,
	};
	const channels = await ensureChannels(state, slack);
	assert.equal(channels.length, 1);
	assert.equal(calls.length, 0);
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
	const matches = await discoverMatches(channels, "octo", "hello", 42, slack);
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
	await discoverMatches(channels, "o", "r", 1, slack);
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
	await discoverMatches([{ id: "C1", name: "x" }], "o", "r", 1, slack);
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
		[{ id: "C1", name: "x" }],
		"octo",
		"hello",
		42,
		slack,
	);
	assert.deepEqual(matches, [{ channel: "C1", ts: "1.5" }]);
});

// ---------------------------------------------------------------- ensureBotUserId / auth errors

test("ensureBotUserId: caches the bot user id and skips auth.test on second call", async () => {
	const { slack, calls } = slackFor({
		"auth.test": [{ body: { ok: true, user_id: "U0BOT" } }],
	});
	const state = {};
	await ensureBotUserId(state, slack);
	await ensureBotUserId(state, slack);
	assert.equal(state.botUserId, "U0BOT");
	assert.equal(calls.length, 1);
});

test("ensureBotUserId: throws AuthError on invalid_auth (so caller can clean-exit)", async () => {
	const { slack } = slackFor({
		"auth.test": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	await assert.rejects(
		ensureBotUserId({}, slack),
		(e) => e instanceof AuthError && e.code === "invalid_auth",
	);
});

// ---------------------------------------------------------------- reactToMatch (flip cleanup)

test("reactToMatch: approved with our bot owning a stale changes-requested removes the warning, then adds approved", async () => {
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
	const result = await reactToMatch(
		{ channel: "C1", ts: "1.0" },
		ctx({
			slack,
			status: "approved",
			emoji: "white_check_mark",
			oppositeEmoji: "warning",
			botUserId: "U0BOT",
		}),
	);
	assert.equal(result.ok, true);
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.remove", "reactions.add"],
	);
});

test("reactToMatch: approved without our bot in the warning users array does NOT remove someone else’s warning", async () => {
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
	await reactToMatch(
		{ channel: "C1", ts: "1.0" },
		ctx({
			slack,
			status: "approved",
			emoji: "white_check_mark",
			oppositeEmoji: "warning",
			botUserId: "U0BOT",
		}),
	);
	// No reactions.remove call.
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.get", "reactions.add"],
	);
});

test("reactToMatch: when isRerun=true, skips the entire flip-cleanup branch (re-run safety)", async () => {
	const { slack, calls } = slackFor({
		"reactions.add": [{ body: { ok: true } }],
	});
	await reactToMatch(
		{ channel: "C1", ts: "1.0" },
		ctx({
			slack,
			status: "approved",
			emoji: "white_check_mark",
			oppositeEmoji: "warning",
			botUserId: "U0BOT",
			isRerun: true,
		}),
	);
	// No reactions.get, no reactions.remove. Just the additive add.
	assert.deepEqual(
		calls.map((c) => c.method),
		["reactions.add"],
	);
});

test("reactToMatch: tolerated reaction errors (already_reacted) do not throw", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "already_reacted" } }],
	});
	// No oppositeEmoji passed so flip cleanup is skipped.
	const result = await reactToMatch(
		{ channel: "C1", ts: "1.0" },
		ctx({ slack, emoji: "large_purple_square" }),
	);
	assert.equal(result.error, "already_reacted");
});

test("reactToMatch: stale-match errors (channel_not_found) surface so caller can prune cache", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "channel_not_found" } }],
	});
	const result = await reactToMatch(
		{ channel: "C1", ts: "1.0" },
		ctx({ slack, emoji: "large_purple_square" }),
	);
	assert.equal(result.error, "channel_not_found");
});

test("reactToMatch: invalid_auth on reactions.add propagates as AuthError", async () => {
	const { slack } = slackFor({
		"reactions.add": [{ body: { ok: false, error: "invalid_auth" } }],
	});
	await assert.rejects(
		reactToMatch({ channel: "C1", ts: "1.0" }, ctx({ slack })),
		(e) => e instanceof AuthError && e.code === "invalid_auth",
	);
});
