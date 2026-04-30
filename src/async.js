// AbortSignal-aware sleep until a wall-clock deadline (Date.now() ms).
// Idempotent under retries: pass the same deadline through and the total
// wait stays bounded, however many times callers re-enter the wait.
export const sleepUntil = (deadlineMs, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const remaining = deadlineMs - Date.now();
		if (remaining <= 0) return resolve();
		const timer = setTimeout(resolve, remaining);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

// Race a promise against a signal: rejects with the signal's reason if it
// fires before the promise settles.
export async function abortable(promise, signal) {
	if (signal.aborted) throw signal.reason;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

// Invoke `fn` up to `maxAttempts`. On a thrown error, ask `isRetryable`;
// if yes, sleep until `getDeadline(error, attempt)` and try again. `signal`
// aborts in-flight sleeps and short-circuits before the next attempt.
// `onRetry` fires after each failure that's about to retry. Throws on
// exhaustion.
export async function retry(
	fn,
	{ maxAttempts, signal, isRetryable, getDeadline, onRetry },
) {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try {
			return await fn();
		} catch (e) {
			if (attempt + 1 >= maxAttempts || !isRetryable(e)) throw e;
			onRetry(e, attempt);
			await sleepUntil(getDeadline(e, attempt), signal);
		}
	}
}
