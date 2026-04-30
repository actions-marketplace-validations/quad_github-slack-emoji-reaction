import { retry } from "./async.js";
import { FatalError } from "./errors.js";

class NetworkError extends FatalError {
	constructor(method, cause) {
		super(`Slack ${method} failed`, { cause });
	}
}

class RateLimitError extends Error {
	constructor(body, deadlineMs) {
		super();
		this.body = body;
		this.deadlineMs = deadlineMs;
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
			if (e instanceof RateLimitError) return e.body;
			throw e;
		}
	}

	async #callOnce(method, params) {
		let res;
		try {
			res = await this.#sendRequest(method, params);
		} catch (e) {
			if (e instanceof DOMException) throw e;
			throw new NetworkError(method, e);
		}
		const body = await res.json();
		SlackClient.#enforceRateLimit(method, res, body);
		SlackClient.#enforceAuth(body);
		return body;
	}

	#sendRequest(method, params) {
		return this.#fetch(new URL(method, SlackClient.#SLACK_API), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(params || {}),
			signal: this.#signal,
		});
	}

	static #enforceRateLimit(method, res, body) {
		const limited =
			res.status === 429 ||
			(body?.ok === false && body.error === "ratelimited");
		if (!limited) return;
		const secs = Number(res.headers.get("retry-after")) || 1;
		if (secs > SlackClient.#RETRY_AFTER_CAP_S) {
			throw new FatalError(
				`Slack ${method} rate limit too long: ${secs}s exceeds ${SlackClient.#RETRY_AFTER_CAP_S}s; giving up`,
			);
		}
		throw new RateLimitError(body, Date.now() + secs * 1000);
	}

	static #enforceAuth(body) {
		if (body?.ok === false && SlackClient.#AUTH_ERRORS.has(body.error)) {
			throw new FatalError(
				`Slack auth error: ${body.error}. Refresh the SLACK_TOKEN secret.`,
			);
		}
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

	static #networkBackoffMs() {
		const base = SlackClient.#NETWORK_RETRY_MS;
		return base + Math.random() * base;
	}
}
