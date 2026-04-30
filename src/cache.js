// Restore/save state against the GHA Cache v1 API. ACTIONS_CACHE_URL +
// ACTIONS_RUNTIME_TOKEN are auto-injected into every workflow job.
export class CacheClient {
	#base;
	#token;
	#fetch;
	#headers;
	#enabled;
	#keyPrefix;
	#version;
	#runKey;

	constructor({
		env = process.env,
		fetch = globalThis.fetch,
		keyPrefix = "slack-emoji-reactions-state-",
		version = "slack-emoji-reactions-v1",
	} = {}) {
		const rawBase = env.ACTIONS_CACHE_URL || "";
		this.#base = rawBase.endsWith("/") ? rawBase : rawBase ? `${rawBase}/` : "";
		this.#token = env.ACTIONS_RUNTIME_TOKEN || "";
		this.#fetch = fetch;
		this.#headers = {
			Authorization: `Bearer ${this.#token}`,
			Accept: "application/json;api-version=6.0-preview.1",
		};
		this.#enabled = !!this.#base && !!this.#token;
		this.#keyPrefix = keyPrefix;
		this.#version = version;
		this.#runKey = `${env.GITHUB_RUN_ID || "norunid"}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
	}

	#url(path) {
		return new URL(`_apis/artifactcache/${path}`, this.#base);
	}

	#send(path, init = {}) {
		return this.#fetch(this.#url(path), {
			...init,
			headers: { ...this.#headers, ...(init.headers || {}) },
		});
	}

	async restore() {
		if (!this.#enabled) return null;
		try {
			const lookup = this.#url("cache");
			// Sentinel primary key never matches; the second key is a prefix lookup
			// against every entry we've saved, returning the most recent one.
			lookup.searchParams.set(
				"keys",
				`${this.#keyPrefix}__sentinel__,${this.#keyPrefix}`,
			);
			lookup.searchParams.set("version", this.#version);
			const res = await this.#fetch(lookup, { headers: this.#headers });
			if (res.status === 204) return null;
			if (!res.ok) {
				console.warn(`cache restore lookup status ${res.status}`);
				return null;
			}
			const meta = await res.json();
			if (!meta?.archiveLocation) return null;
			const blob = await this.#fetch(meta.archiveLocation);
			if (!blob.ok) {
				console.warn(`cache blob fetch status ${blob.status}`);
				return null;
			}
			return await blob.json();
		} catch (e) {
			console.warn(`cache restore failed: ${e.message}`);
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
					key: `${this.#keyPrefix}${this.#runKey}`,
					version: this.#version,
					cacheSize: body.length,
				}),
			});
			if (!reserveRes.ok) {
				console.warn(`cache reserve status ${reserveRes.status}`);
				return;
			}
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
			if (!uploadRes.ok) {
				console.warn(`cache upload status ${uploadRes.status}`);
				return;
			}

			const commitRes = await this.#send(`caches/${cacheId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ size: body.length }),
			});
			if (!commitRes.ok) {
				console.warn(`cache commit status ${commitRes.status}`);
			}
		} catch (e) {
			console.warn(`cache save failed: ${e.message}`);
		}
	}
}
