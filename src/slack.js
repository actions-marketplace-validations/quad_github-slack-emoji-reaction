import { FatalError } from "./errors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlackClient {
	static #SLACK_API = "https://slack.com/api/";
	static #AUTH_ERRORS = new Set([
		"invalid_auth",
		"token_revoked",
		"account_inactive",
		"not_authed",
	]);

	#token;
	#fetch;
	#apiBase;
	#maxRetries;
	#retryAfterCapS;

	constructor({
		token,
		fetch = globalThis.fetch,
		apiBase = SlackClient.#SLACK_API,
		maxRetries = 3,
		retryAfterCapS = 60,
	} = {}) {
		this.#token = token;
		this.#fetch = fetch;
		this.#apiBase = apiBase;
		this.#maxRetries = maxRetries;
		this.#retryAfterCapS = retryAfterCapS;
	}

	// Outcome:
	//   { kind: "ok", body }                       — return body
	//   { kind: "ratelimited", waitMs, body }      — sleep waitMs, retry
	//   { kind: "network", waitMs, body }          — sleep waitMs, retry
	// `body` carries what we'd surface if retries are exhausted.
	async #callOnce(method, params) {
		let res;
		try {
			res = await this.#fetch(this.#apiBase + method, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(params || {}),
			});
		} catch (e) {
			return {
				kind: "network",
				waitMs: 1000,
				body: { ok: false, error: "network_error", message: e.message },
			};
		}
		const body = await res.json();
		// Slack reports rate limiting two ways: 429 with Retry-After, and
		// HTTP 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
		const rateLimited =
			res.status === 429 ||
			(body?.ok === false && body.error === "ratelimited");
		if (rateLimited) {
			const secs = Math.min(
				Number(res.headers.get("retry-after")) || 1,
				this.#retryAfterCapS,
			);
			return { kind: "ratelimited", waitMs: secs * 1000, body };
		}
		if (body?.ok === false && SlackClient.#AUTH_ERRORS.has(body.error)) {
			throw new FatalError(
				`Slack auth error: ${body.error}. Refresh the SLACK_TOKEN secret.`,
			);
		}
		return { kind: "ok", body };
	}

	async call(method, params) {
		let outcome;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			outcome = await this.#callOnce(method, params);
			if (outcome.kind === "ok") return outcome.body;
			const tag = `slack ${method} ${outcome.kind}`;
			const where = `(attempt ${attempt + 1}/${this.#maxRetries + 1})`;
			console.warn(
				outcome.kind === "network"
					? `${tag}: ${outcome.body.message} ${where}`
					: `${tag}; retry-after ${outcome.waitMs / 1000}s ${where}`,
			);
			if (attempt >= this.#maxRetries) break;
			await sleep(outcome.waitMs);
		}
		return outcome.body;
	}

	// Yields successive Slack pages, threading cursor through. Caps at
	// `maxPages` if given; otherwise drains to completion. Stops on
	// non-ok response or empty next_cursor.
	async *paginate(method, baseParams, { maxPages = Infinity } = {}) {
		let cursor = "";
		for (let page = 0; page < maxPages; page++) {
			const params = { ...baseParams };
			if (cursor) params.cursor = cursor;
			const res = await this.call(method, params);
			yield res;
			if (!res.ok) return;
			cursor = res.response_metadata?.next_cursor || "";
			if (!cursor) return;
		}
	}
}
