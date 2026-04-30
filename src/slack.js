import { retry } from "./async.js";
import { FatalError } from "./errors.js";

// Thrown by #callOnce on 429 / ok:false ratelimited responses. Carries the
// body so call()'s catch can surface it on retry exhaustion, plus the
// retry-after deadline so the retry loop knows when to wake.
class RateLimitError extends Error {
	constructor(body, deadlineMs) {
		super();
		this.body = body;
		this.deadlineMs = deadlineMs;
	}
}

// Thrown by #callOnce when fetch itself fails (DNS, TCP, etc.). call()'s
// catch synthesises a Slack-shaped body on exhaustion.
class NetworkError extends Error {
	constructor(cause) {
		super(undefined, { cause });
	}
}

export class SlackClient {
	static #SLACK_API = "https://slack.com/api/";
	static #MAX_ATTEMPTS = 3;
	static #RETRY_AFTER_CAP_S = 60;
	static #NETWORK_RETRY_MS = 1000;
	static #AUTH_ERRORS = new Set([
		"invalid_auth",
		"token_revoked",
		"account_inactive",
		"not_authed",
	]);

	#token;
	#fetch;
	#signal;

	constructor({ token, fetch, signal }) {
		this.#token = token;
		this.#fetch = fetch;
		this.#signal = signal;
	}

	async call(method, params) {
		try {
			return await retry(() => this.#callOnce(method, params), {
				maxAttempts: SlackClient.#MAX_ATTEMPTS,
				signal: this.#signal,
				isRetryable: (e) =>
					e instanceof RateLimitError || e instanceof NetworkError,
				getDeadline: (e) =>
					e instanceof RateLimitError
						? e.deadlineMs
						: Date.now() + SlackClient.#networkBackoffMs(),
			});
		} catch (e) {
			// Retry exhausted: surface a body so callers read .ok/.error
			// without needing try/catch. Auth + abort errors propagate.
			if (e instanceof RateLimitError) return e.body;
			if (e instanceof NetworkError)
				return { ok: false, error: "network_error", message: e.cause.message };
			throw e;
		}
	}

	async #callOnce(method, params) {
		let res;
		try {
			res = await this.#fetch(new URL(method, SlackClient.#SLACK_API), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(params || {}),
				signal: this.#signal,
			});
		} catch (e) {
			if (e instanceof DOMException) throw e;
			throw new NetworkError(e);
		}
		const body = await res.json();
		// Slack reports rate limiting two ways: 429 with Retry-After, and
		// HTTP 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
		const limited =
			res.status === 429 ||
			(body?.ok === false && body.error === "ratelimited");
		if (limited) {
			const secs = Math.min(
				Number(res.headers.get("retry-after")) || 1,
				SlackClient.#RETRY_AFTER_CAP_S,
			);
			throw new RateLimitError(body, Date.now() + secs * 1000);
		}
		if (body?.ok === false && SlackClient.#AUTH_ERRORS.has(body.error)) {
			throw new FatalError(
				`Slack auth error: ${body.error}. Refresh the SLACK_TOKEN secret.`,
			);
		}
		return body;
	}

	async *paginate(method, baseParams, maxPages) {
		let cursor = "";
		for (let page = 0; page < maxPages; page++) {
			const res = await this.call(method, {
				...baseParams,
				...(cursor && { cursor }),
			});
			yield res;
			if (!res.ok) return;
			cursor = res.response_metadata?.next_cursor || "";
			if (!cursor) return;
		}
	}

	// Half jitter on the network retry: uniformly distributed over
	// [base, 2*base) so concurrent runs hit Slack on staggered schedules.
	// Slack's Retry-After is server-driven; we don't jitter that path.
	static #networkBackoffMs() {
		const base = SlackClient.#NETWORK_RETRY_MS;
		return base + Math.random() * base;
	}
}
