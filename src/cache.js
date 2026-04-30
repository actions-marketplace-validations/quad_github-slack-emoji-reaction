// Restore/save state against the GHA Cache v1 API. ACTIONS_CACHE_URL +
// ACTIONS_RUNTIME_TOKEN are auto-injected into every workflow job.
export class CacheClient {
	static #KEY_PREFIX = "slack-emoji-reactions-state-";
	static #VERSION = "slack-emoji-reactions-v1";

	#base;
	#token;
	#headers;
	#enabled;
	#runKey;

	constructor() {
		const env = process.env;
		const raw = env.ACTIONS_CACHE_URL;
		const root = raw && new URL(raw.endsWith("/") ? raw : `${raw}/`);
		this.#base = root && new URL("_apis/artifactcache/", root);
		this.#token = env.ACTIONS_RUNTIME_TOKEN || "";
		this.#headers = {
			Authorization: `Bearer ${this.#token}`,
			Accept: "application/json;api-version=6.0-preview.1",
		};
		this.#enabled = !!this.#base && !!this.#token;
		this.#runKey = `${env.GITHUB_RUN_ID || "norunid"}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
	}

	#url(path) {
		return new URL(path, this.#base);
	}

	#send(path, init) {
		return fetch(this.#url(path), {
			...init,
			headers: { ...this.#headers, ...(init.headers || {}) },
		});
	}

	async restore(signal) {
		if (!this.#enabled) return null;
		try {
			const lookup = this.#url("cache");
			// Sentinel primary key never matches; the second key is a prefix lookup
			// against every entry we've saved, returning the most recent one.
			lookup.searchParams.set(
				"keys",
				`${CacheClient.#KEY_PREFIX}__sentinel__,${CacheClient.#KEY_PREFIX}`,
			);
			lookup.searchParams.set("version", CacheClient.#VERSION);
			const res = await fetch(lookup, { headers: this.#headers, signal });
			if (!res.ok) return null;
			const meta = await res.json();
			if (!meta?.archiveLocation) return null;
			const blob = await fetch(meta.archiveLocation, { signal });
			if (!blob.ok) return null;
			return await blob.json();
		} catch {
			return null;
		}
	}

	async save(state) {
		if (!this.#enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");

			const reserveRes = await this.#send("caches", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: `${CacheClient.#KEY_PREFIX}${this.#runKey}`,
					version: CacheClient.#VERSION,
					cacheSize: body.length,
				}),
			});
			if (!reserveRes.ok) return;
			const cacheId = (await reserveRes.json())?.cacheId;
			if (!cacheId) return;

			const uploadRes = await this.#send(`caches/${cacheId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Range": `bytes 0-${body.length - 1}/*`,
				},
				body,
			});
			if (!uploadRes.ok) return;

			await this.#send(`caches/${cacheId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ size: body.length }),
			});
		} catch {
			// swallow
		}
	}
}
