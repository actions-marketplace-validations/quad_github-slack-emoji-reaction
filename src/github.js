// SPDX-License-Identifier: MIT
import { FatalError } from "./errors.js";

export class GitHubClient {
	static #API = "https://api.github.com/";

	#headers;
	#signal;

	constructor(token, signal) {
		this.#headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "github-slack-emoji-reaction",
		};
		this.#signal = signal;
	}

	async graphql(query, variables) {
		const res = await fetch(new URL("graphql", GitHubClient.#API), {
			method: "POST",
			headers: { ...this.#headers, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal: this.#signal,
		});
		if (!res.ok) throw new FatalError(`GitHub graphql failed: ${res.status}`);
		const body = await res.json();
		if (body.errors) {
			throw new FatalError(`GitHub graphql: ${body.errors[0].message}`);
		}
		return body.data;
	}
}
