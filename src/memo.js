const nowS = () => Math.floor(Date.now() / 1000);

// Keyed map of { value, refreshedAt } cells. Plain reads/writes plus
// TTL-aware memoization (ensure), stale-sweep, and oldest-first cap.
export class Memo {
	#cells;

	constructor(cells = {}) {
		this.#cells = cells;
	}

	get(key) {
		return this.#cells[key]?.value;
	}

	set(key, value) {
		this.#cells[key] = { value, refreshedAt: nowS() };
	}

	delete(key) {
		delete this.#cells[key];
	}

	// Returns the cached value if its age is under `ttlS`; otherwise runs
	// `fetcher`, writes the result back, and returns it.
	async ensure(key, ttlS, fetcher) {
		const cell = this.#cells[key];
		if (cell && nowS() - cell.refreshedAt < ttlS) return cell.value;
		const value = await fetcher();
		this.set(key, value);
		return value;
	}

	// Eviction strategy: drop entries last refreshed more than `ttlS` ago.
	evictOlderThan(ttlS) {
		const cutoff = nowS() - ttlS;
		this.#cells = Object.fromEntries(
			Object.entries(this.#cells).filter(([, v]) => v.refreshedAt >= cutoff),
		);
	}

	// Eviction strategy: keep the `max` most-recently-refreshed entries
	// (oldest refreshedAt dropped first). Returns count evicted. LRU-shaped
	// only when every interaction with a key ends in a set — true for
	// prMatches but not in general; readers shouldn't bank on it.
	evictOldestPast(max) {
		const keys = Object.keys(this.#cells);
		if (keys.length <= max) return 0;
		keys.sort(
			(a, b) => this.#cells[a].refreshedAt - this.#cells[b].refreshedAt,
		);
		const evict = keys.slice(0, keys.length - max);
		for (const k of evict) delete this.#cells[k];
		return evict.length;
	}

	toJSON() {
		return this.#cells;
	}
}
