// SPDX-License-Identifier: MIT
import fs from "node:fs";

import { FatalError } from "../errors.js";

const STATUS_APPROVED = "approved";
const STATUS_CHANGES_REQUESTED = "changes-requested";
const STATUS_COMMENTED = "commented";
const STATUS_MERGED = "merged";
const STATUS_CLOSED = "closed";

const FLIP_OPPOSITE = {
	[STATUS_APPROVED]: STATUS_CHANGES_REQUESTED,
	[STATUS_CHANGES_REQUESTED]: STATUS_APPROVED,
};

export function deriveStatus(eventName, payload) {
	if (eventName === "pull_request_review") {
		if (payload.action !== "submitted") return null;
		const state = payload.review?.state;
		if (state === "approved") return STATUS_APPROVED;
		if (state === "changes_requested") return STATUS_CHANGES_REQUESTED;
		if (state === "commented") {
			// Bot-filed reviews (Dependabot, Renovate, etc.) are constant noise.
			if (payload.review?.user?.type === "Bot") return null;
			return STATUS_COMMENTED;
		}
		return null;
	}
	if (eventName === "pull_request") {
		if (payload.action !== "closed") return null;
		return payload.pull_request?.merged ? STATUS_MERGED : STATUS_CLOSED;
	}
	return null;
}

export function prContext(payload) {
	const pr = payload.pull_request;
	const owner = pr?.base?.repo?.owner?.login;
	const repo = pr?.base?.repo?.name;
	const num = pr?.number;
	if (!owner || !repo || !Number.isFinite(num)) return null;
	return { owner, repo, num };
}

export function readJob() {
	// GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
	const input = (name) =>
		(process.env[`INPUT_${name.toUpperCase()}`] || "").trim();

	const eventPath = FatalError.notNull(
		process.env.GITHUB_EVENT_PATH,
		"GITHUB_EVENT_PATH not set; not running inside GitHub Actions",
	);
	const eventName = FatalError.notNull(
		process.env.GITHUB_EVENT_NAME,
		"GITHUB_EVENT_NAME not set; not running inside GitHub Actions",
	);
	const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

	const status = deriveStatus(eventName, payload);
	if (!status) return null;
	const emoji = input(`emoji-${status}`);
	if (!emoji) return null;

	const token = input("slack-token");
	if (!token) {
		// Fork PRs run with empty secrets
		if (payload.pull_request?.head?.repo?.fork) return null;
		throw new FatalError("slack-token is missing; set the SLACK_TOKEN secret");
	}

	const pr = FatalError.notNull(
		prContext(payload),
		"could not derive PR context from payload",
	);

	const oppositeStatus = FLIP_OPPOSITE[status];
	const opposite = oppositeStatus ? input(`emoji-${oppositeStatus}`) : "";

	return {
		status,
		token,
		emoji,
		opposite,
		isRerun: Number(process.env.GITHUB_RUN_ATTEMPT) > 1,
		closesPR: status === STATUS_MERGED || status === STATUS_CLOSED,
		pr,
		prKey: `${pr.owner}/${pr.repo}#${pr.num}`,
	};
}
