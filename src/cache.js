// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import * as log from "./log.js";

// Restore/save state against the GHA Cache v2 API. ACTIONS_RESULTS_URL + ACTIONS_RUNTIME_TOKEN are auto-injected into every workflow job.
export class CacheClient {
	// Namespaced so this action's entries don't collide with anything else in the per-repo GHA cache; bump the trailing version when the serialized cache shape changes.
	static #NAMESPACE = "quad-github-slack-emoji-reaction-v1";
	static #KEY_PREFIX = `${CacheClient.#NAMESPACE}-state-`;
	// Server requires a 64-char hex SHA-256; any deterministic input works.
	static #VERSION = createHash("sha256")
		.update(CacheClient.#NAMESPACE)
		.digest("hex");
	static #SERVICE = "twirp/github.actions.results.api.v1.CacheService/";

	#base;
	#headers;
	#enabled;
	#runKey;

	constructor() {
		const env = process.env;
		const url = env.ACTIONS_RESULTS_URL;
		const token = env.ACTIONS_RUNTIME_TOKEN;
		if (!url || !token || !URL.canParse(url)) {
			this.#enabled = false;
			// Outside GHA (local testing) the env vars are absent by design. Inside GHA they should always be present — warn so misconfig is visible. Action still works; runs just don't cache.
			if (env.GITHUB_ACTIONS) {
				log.warn(
					"GHA cache unavailable; runs will re-discover Slack messages each time.",
				);
			}
			return;
		}
		// new URL(relative, base) needs a trailing slash on base or it'd resolve relative as a sibling of the last path segment.
		this.#base = new URL(CacheClient.#SERVICE, url.replace(/\/?$/, "/"));
		this.#headers = {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		this.#runKey = `${env.GITHUB_RUN_ID || "norunid"}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
		this.#enabled = true;
	}

	async restore(signal) {
		if (!this.#enabled) return null;
		try {
			const lookup = await this.#twirp("GetCacheEntryDownloadURL", signal, {
				key: `${CacheClient.#KEY_PREFIX}__sentinel__`,
				restoreKeys: [CacheClient.#KEY_PREFIX],
				version: CacheClient.#VERSION,
			});
			// proto3 JSON omits default values, so `ok: true` may not appear in the response — rely on the URL's presence as the success signal.
			if (!lookup.signedDownloadUrl) return null;
			const blob = await fetch(lookup.signedDownloadUrl, { signal });
			if (!blob.ok) throw new Error(`blob fetch ${blob.status}`);
			return await blob.json();
		} catch (e) {
			if (e instanceof DOMException) throw e;
			log.warn(`cache restore failed: ${e.message}`);
			return null;
		}
	}

	async save(state) {
		if (!this.#enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");
			const key = `${CacheClient.#KEY_PREFIX}${this.#runKey}`;
			const reserved = await this.#twirp("CreateCacheEntry", null, {
				key,
				version: CacheClient.#VERSION,
			});
			if (!reserved.signedUploadUrl) {
				throw new Error(`reserve: ${JSON.stringify(reserved)}`);
			}
			await this.#azurePut(reserved.signedUploadUrl, body);
			// sizeBytes is proto int64 → JSON string, not number. #twirp throws on non-2xx, which is the real success signal — proto3 JSON would omit `ok: true` from the body.
			await this.#twirp("FinalizeCacheEntryUpload", null, {
				key,
				version: CacheClient.#VERSION,
				sizeBytes: String(body.length),
			});
		} catch (e) {
			log.warn(`cache save failed: ${e.message}`);
		}
	}

	async #twirp(method, signal, payload) {
		const res = await fetch(new URL(method, this.#base), {
			method: "POST",
			headers: this.#headers,
			body: JSON.stringify(payload),
			signal,
		});
		if (!res.ok) throw new Error(`${method} ${res.status}`);
		return res.json();
	}

	// SAS query params are the credential; sending Authorization would 403.
	async #azurePut(url, body) {
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				"x-ms-blob-type": "BlockBlob",
				"x-ms-version": "2020-04-08",
				"Content-Type": "application/octet-stream",
				"Content-Length": String(body.length),
			},
			body,
		});
		if (!res.ok) throw new Error(`upload ${res.status}`);
	}
}
