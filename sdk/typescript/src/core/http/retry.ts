import { SECOND_IN_MS } from "../runtime.js";

const BASE_RETRY_WAIT_IN_MS = 200;
export const MAX_RETRY_WAIT_MS = 30_000;
/** Seconds from a `Retry-After` header (delay-seconds or HTTP date). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  // RFC 9110 recipients accept IMF-fixdate and the two obsolete HTTP dates.
  if (
    /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
      trimmed,
    ) === false
  )
    return undefined;
  const date = Date.parse(trimmed.endsWith("GMT") ? trimmed : `${trimmed} GMT`);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / SECOND_IN_MS));
}

export function sleep(delayInMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
    if (signal?.aborted === true) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayInMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoff(attempt: number, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) return retryAfter * SECOND_IN_MS;
  // Full jitter: spreads clients that failed together.
  return Math.random() * Math.min(BASE_RETRY_WAIT_IN_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
}
