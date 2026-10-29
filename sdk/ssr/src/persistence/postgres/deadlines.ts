import { SessionError } from "../../errors.js";

export const DEFAULT_QUERY_TIMEOUT_IN_MS = 5_000;
export const DEFAULT_LEASE_TIMEOUT_IN_MS = 60_000;
const MAX_QUERY_TIMEOUT_IN_MS = 30_000;
const MAX_LEASE_TIMEOUT_IN_MS = 120_000;

export function requireDeadlines(timeout: number, leaseTimeout: number): void {
  if (
    Number.isSafeInteger(timeout) === false ||
    timeout < 100 ||
    timeout > MAX_QUERY_TIMEOUT_IN_MS ||
    Number.isSafeInteger(leaseTimeout) === false ||
    leaseTimeout < 2 * timeout ||
    leaseTimeout > MAX_LEASE_TIMEOUT_IN_MS
  )
    throw new SessionError("configuration", "Invalid session store deadlines");
}

export async function boundedOperation<T>(
  operation: Promise<T>,
  timeoutInMs: number,
  message = "Session store deadline exceeded",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SessionError("session_store", message)), timeoutInMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
