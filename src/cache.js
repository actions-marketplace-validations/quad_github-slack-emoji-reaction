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
		const url = env.ACTIONS_CACHE_URL;
		const token = env.ACTIONS_RUNTIME_TOKEN;
		if (!url || !token || !URL.canParse(url)) {
			this.#enabled = false;
			// Outside GHA (local testing) the env vars are absent by design.
			// Inside GHA they should always be present — warn so misconfig
			// is visible. Action still works; runs just don't cache.
			if (env.GITHUB_ACTIONS) {
				console.warn(
					"GHA cache unavailable; runs will re-discover Slack messages each time.",
				);
			}
			return;
		}
		// new URL(relative, base) needs a trailing slash on base or it'd
		// resolve relative as a sibling of the last path segment.
		this.#base = new URL("_apis/artifactcache/", url.replace(/\/?$/, "/"));
		this.#token = token;
		this.#headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json;api-version=6.0-preview.1",
		};
		this.#runKey = `${env.GITHUB_RUN_ID || "norunid"}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
		this.#enabled = true;
	}

	#url(path) {
		return new URL(path, this.#base);
	}

	#send(url, init) {
		return fetch(url, {
			...init,
			headers: { ...this.#headers, ...init.headers },
		});
	}

	async restore(signal) {
		if (!this.#enabled) return null;
		try {
			const meta = await this.#lookup(signal);
			if (!meta?.archiveLocation) return null;
			const blob = await fetch(meta.archiveLocation, { signal });
			return blob.ok ? await blob.json() : null;
		} catch (e) {
			// Deadline-driven aborts propagate so the run exits cleanly.
			if (e instanceof DOMException) throw e;
			console.warn(`cache restore failed: ${e.message}`);
			return null;
		}
	}

	async save(state) {
		if (!this.#enabled) return;
		try {
			const body = Buffer.from(JSON.stringify(state), "utf8");
			const cacheId = await this.#reserve(body.length);
			if (!cacheId) return;
			if (!(await this.#upload(cacheId, body))) return;
			await this.#commit(cacheId, body.length);
		} catch (e) {
			// finally-context: must not propagate or we'd mask the original
			// error. Log so real bugs in save aren't invisible.
			console.warn(`cache save failed: ${e.message}`);
		}
	}

	// Sentinel primary key never matches; the second key is a prefix lookup
	// against every entry we've saved, returning the most recent one.
	async #lookup(signal) {
		const url = this.#url("cache");
		url.searchParams.set(
			"keys",
			`${CacheClient.#KEY_PREFIX}__sentinel__,${CacheClient.#KEY_PREFIX}`,
		);
		url.searchParams.set("version", CacheClient.#VERSION);
		const res = await this.#send(url, { signal });
		return res.ok ? await res.json() : null;
	}

	async #reserve(size) {
		const res = await this.#send(this.#url("caches"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				key: `${CacheClient.#KEY_PREFIX}${this.#runKey}`,
				version: CacheClient.#VERSION,
				cacheSize: size,
			}),
		});
		return res.ok ? ((await res.json())?.cacheId ?? null) : null;
	}

	async #upload(cacheId, body) {
		const res = await this.#send(this.#url(`caches/${cacheId}`), {
			method: "PATCH",
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Range": `bytes 0-${body.length - 1}/*`,
			},
			body,
		});
		return res.ok;
	}

	async #commit(cacheId, size) {
		await this.#send(this.#url(`caches/${cacheId}`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ size }),
		});
	}
}
