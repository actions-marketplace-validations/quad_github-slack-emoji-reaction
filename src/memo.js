// SPDX-License-Identifier: MIT
const nowS = () => Math.floor(Date.now() / 1000);

export class Memo {
	#cells;

	constructor(cells) {
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
	async getOrSet(key, ttlS, fetcher) {
		const cell = this.#cells[key];
		if (cell && nowS() - cell.refreshedAt < ttlS) return cell.value;
		const value = await fetcher();
		this.set(key, value);
		return value;
	}

	#evict(keep) {
		this.#cells = Object.fromEntries(
			Object.entries(this.#cells).filter(([k, v]) => keep(v, k)),
		);
	}

	evictOlderThan(ttlS) {
		const cutoff = nowS() - ttlS;
		this.#evict((v) => v.refreshedAt >= cutoff);
	}

	// LRU-shaped only when every interaction with a key ends in a set — true
	// for prMatches but not in general; readers shouldn't bank on it.
	evictOldestPast(max) {
		const keys = Object.keys(this.#cells);
		if (keys.length <= max) return;
		keys.sort(
			(a, b) => this.#cells[a].refreshedAt - this.#cells[b].refreshedAt,
		);
		const keep = new Set(keys.slice(keys.length - max));
		this.#evict((_, k) => keep.has(k));
	}

	toJSON() {
		return this.#cells;
	}
}
