import { SessionError } from "../../errors.js";

const DEFAULT_QUERY_TIMEOUT_IN_MS = 5_000;
const DEFAULT_LEASE_TIMEOUT_IN_MS = 60_000;
const MAX_QUERY_TIMEOUT_IN_MS = 30_000;
const MAX_LEASE_TIMEOUT_IN_MS = 120_000;
const MIN_QUERY_TIMEOUT_IN_MS = 100;
/** node-postgres's default `max`. */
const DEFAULT_POOL_SIZE = 10;
const MAX_LEASES = 1_000;

export interface PostgresSessionStoreOptions {
  /** Deadline for each statement and connection borrow, in ms. Default 5000. */
  timeout?: number;
  /** Longest one write may own its session, in ms (it holds a pooled connection
   * and the session's advisory lock meanwhile). Default 60000. */
  leaseTimeout?: number;
  /** How long a write waits for the current owner of the same session, in ms.
   * Default `leaseTimeout`, so a waiter never gives up on an owner that is still
   * within its own budget. Shorter values fail fast with `session_store`. */
  lockTimeout?: number;
  /** Concurrent write leases, each holding one pooled connection. Default half the
   * pool's `max` (node-postgres default 10), at least one, so reads always keep
   * connections. Further writers wait for a slot within `lockTimeout`. */
  maxLeases?: number;
}

export interface StoreDeadlines {
  timeout: number;
  leaseTimeout: number;
  lockTimeout: number;
  maxLeases: number;
}

function integerIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function storeDeadlines(
  options: PostgresSessionStoreOptions,
  poolSize: number | undefined,
): StoreDeadlines {
  const timeout = options.timeout ?? DEFAULT_QUERY_TIMEOUT_IN_MS;
  const leaseTimeout = options.leaseTimeout ?? DEFAULT_LEASE_TIMEOUT_IN_MS;
  const lockTimeout = options.lockTimeout ?? leaseTimeout;
  const deadlines = {
    timeout,
    leaseTimeout,
    lockTimeout,
    maxLeases: options.maxLeases ?? defaultLeases(poolSize),
  };
  requireDeadlines(deadlines);
  return deadlines;
}

/** Half the pool, so reads keep connections while writes hold theirs. */
function defaultLeases(poolSize: number | undefined): number {
  const size =
    poolSize !== undefined && Number.isSafeInteger(poolSize) && poolSize > 0
      ? poolSize
      : DEFAULT_POOL_SIZE;
  return Math.max(1, Math.floor(size / 2));
}

function requireDeadlines({ timeout, leaseTimeout, lockTimeout, maxLeases }: StoreDeadlines): void {
  if (
    integerIn(timeout, MIN_QUERY_TIMEOUT_IN_MS, MAX_QUERY_TIMEOUT_IN_MS) === false ||
    integerIn(leaseTimeout, 2 * timeout, MAX_LEASE_TIMEOUT_IN_MS) === false ||
    integerIn(lockTimeout, timeout, leaseTimeout) === false ||
    integerIn(maxLeases, 1, MAX_LEASES) === false
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
