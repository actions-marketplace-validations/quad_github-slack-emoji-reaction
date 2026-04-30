// SPDX-License-Identifier: MIT
// Operator-fixable failures: top-level catch prints the message and exits 1
// without a stack. Anything else propagates as an unhandled rejection.
export class FatalError extends Error {
	static notNull(value, message) {
		if (!value) throw new FatalError(message);
		return value;
	}

	static fromSlack(method, body) {
		return new FatalError(`Slack ${method} failed: ${body.error}`);
	}
}
