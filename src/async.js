// AbortSignal-aware sleep until a wall-clock deadline (Date.now() ms).
// Idempotent under retries: passing the same deadline through and re-
// entering doesn't extend the total wait.
export function sleepUntil(deadlineMs, signal) {
	if (signal.aborted) return Promise.reject(signal.reason);
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers();
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal.reason);
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, remaining);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
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
