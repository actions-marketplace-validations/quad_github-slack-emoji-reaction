// SPDX-License-Identifier: MIT
import { Memo } from "./memo.js";

const CHANNEL_LIST_TTL_S = 24 * 3600;
// Matches GHA's own 7-day cache-entry inactivity TTL — the natural ceiling.
const PR_STALE_TTL_S = 7 * 24 * 3600;
const BOT_USER_ID_TTL_S = 30 * 24 * 3600;
const MAX_PR_ENTRIES = 10000;

const CHANNELS_KEY = "channels";
const CURSORS_KEY = "cursors";
const BOT_USER_ID_KEY = "botUserId";

const matchKey = (m) => `${m.channel}|${m.ts}`;

export class State {
	#memo;
	#prMatches;

	constructor({ memo = {}, prMatches = {} } = {}) {
		this.#memo = new Memo(memo);
		this.#prMatches = new Memo(prMatches);
	}

	getChannels(fetcher) {
		return this.#memo.getOrSet(CHANNELS_KEY, CHANNEL_LIST_TTL_S, fetcher);
	}

	setChannels(channels) {
		this.#memo.set(CHANNELS_KEY, channels);
	}

	dropChannels() {
		this.#memo.delete(CHANNELS_KEY);
	}

	getCursor(channelId) {
		return this.#memo.get(CURSORS_KEY)?.[channelId];
	}

	setCursor(channelId, ts) {
		const cursors = this.#memo.get(CURSORS_KEY) ?? {};
		cursors[channelId] = ts;
		this.#memo.set(CURSORS_KEY, cursors);
	}

	dropCursor(channelId) {
		const cursors = this.#memo.get(CURSORS_KEY);
		if (!cursors) return;
		delete cursors[channelId];
		this.#memo.set(CURSORS_KEY, cursors);
	}

	getBotUserId(fetcher) {
		return this.#memo.getOrSet(BOT_USER_ID_KEY, BOT_USER_ID_TTL_S, fetcher);
	}

	setBotUserId(id) {
		this.#memo.set(BOT_USER_ID_KEY, id);
	}

	getLinks(prKey) {
		return this.#prMatches.get(prKey);
	}

	setLinks(prKey, matches) {
		this.#prMatches.set(prKey, matches);
	}

	touchLinks(prKey) {
		this.#prMatches.touch(prKey);
	}

	deleteLinks(prKey) {
		this.#prMatches.delete(prKey);
	}

	mergeLink(prKey, entry) {
		const existing = this.#prMatches.get(prKey) ?? [];
		if (!existing.some((e) => matchKey(e) === matchKey(entry))) {
			this.#prMatches.set(prKey, [...existing, entry]);
		}
	}

	evict() {
		this.#prMatches.evictOlderThan(PR_STALE_TTL_S);
		this.#prMatches.evictOldestPast(MAX_PR_ENTRIES);
	}

	toJSON() {
		return { memo: this.#memo, prMatches: this.#prMatches };
	}
}
