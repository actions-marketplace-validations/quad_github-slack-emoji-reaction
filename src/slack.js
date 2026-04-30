import { FatalError } from "./errors.js";

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

export class SlackClient {
	static #SLACK_API = "https://slack.com/api/";
	static #MAX_RETRIES = 2;
	static #RETRY_AFTER_CAP_S = 60;
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

	// Tagged outcome for call() to consume; `body` is what's returned on
	// retry exhaustion.
	async #callOnce(method, params) {
		let res;
		try {
			res = await this.#sendRequest(method, params);
		} catch (e) {
			if (this.#signal.aborted) throw this.#signal.reason;
			return {
				kind: "network",
				waitMs: 1000,
				body: { ok: false, error: "network_error", message: e.message },
			};
		}
		const body = await res.json();
		const rateLimit = this.#asRateLimit(res, body);
		if (rateLimit) return rateLimit;
		this.#throwIfAuthError(body);
		return { kind: "ok", body };
	}

	#sendRequest(method, params) {
		return this.#fetch(SlackClient.#SLACK_API + method, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(params || {}),
			signal: this.#signal,
		});
	}

	// Slack reports rate limiting two ways: 429 with Retry-After, and HTTP
	// 200 with `{ok:false, error:"ratelimited"}` plus Retry-After.
	#asRateLimit(res, body) {
		const isLimited =
			res.status === 429 ||
			(body?.ok === false && body.error === "ratelimited");
		if (!isLimited) return null;
		const secs = Math.min(
			Number(res.headers.get("retry-after")) || 1,
			SlackClient.#RETRY_AFTER_CAP_S,
		);
		return { kind: "ratelimited", waitMs: secs * 1000, body };
	}

	#throwIfAuthError(body) {
		if (body?.ok === false && SlackClient.#AUTH_ERRORS.has(body.error)) {
			throw new FatalError(
				`Slack auth error: ${body.error}. Refresh the SLACK_TOKEN secret.`,
			);
		}
	}

	async call(method, params) {
		let outcome;
		for (let attempt = 0; attempt <= SlackClient.#MAX_RETRIES; attempt++) {
			this.#signal.throwIfAborted();
			outcome = await this.#callOnce(method, params);
			if (outcome.kind === "ok") return outcome.body;
			console.warn(this.#retryMessage(method, outcome, attempt));
			if (attempt >= SlackClient.#MAX_RETRIES) break;
			await sleep(outcome.waitMs, this.#signal);
		}
		return outcome.body;
	}

	#retryMessage(method, outcome, attempt) {
		const where = `(attempt ${attempt + 1}/${SlackClient.#MAX_RETRIES + 1})`;
		const detail =
			outcome.kind === "network"
				? `: ${outcome.body.message}`
				: `; retry-after ${outcome.waitMs / 1000}s`;
		return `slack ${method} ${outcome.kind}${detail} ${where}`;
	}

	async *paginate(method, baseParams, maxPages) {
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
