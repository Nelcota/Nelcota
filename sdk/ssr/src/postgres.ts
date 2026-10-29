import { SessionError } from "./errors.js";
import { SessionConnections } from "./persistence/postgres/connections.js";
import {
  boundedOperation,
  requireDeadlines,
  DEFAULT_QUERY_TIMEOUT_IN_MS,
  DEFAULT_LEASE_TIMEOUT_IN_MS,
} from "./persistence/postgres/deadlines.js";
import { ownLease } from "./persistence/postgres/lease.js";
import { keyCheck, stored } from "./persistence/postgres/rows.js";
import type { SessionPool } from "./persistence/postgres/types.js";
import type { SessionLease, SessionStore, StoredSession } from "./store.js";
export type { SessionPool, SessionConnection } from "./persistence/postgres/types.js";
const MAX_QUEUED_OWNERS = 256;
/** Session-scoped PG locks survive awaits, and release when the connection dies.
 * Each state save commits independently before its promise resolves. Do not wrap
 * this store in an outer SQL transaction or a transaction-pooling proxy.
 * Same-key callers queue in-process before borrowing. PostgreSQL queues lock
 * waiters fairly; a server-side statement timeout bounds every acquisition.
 */

export class PostgresSessionStore implements SessionStore {
  readonly durability = "shared" as const;
  readonly #connections: SessionConnections;
  readonly #timeout: number;
  #queued = 0;
  readonly #queues = new Map<string, Promise<void>>();
  constructor(
    pool: SessionPool,
    timeout: number = DEFAULT_QUERY_TIMEOUT_IN_MS,
    leaseTimeout: number = DEFAULT_LEASE_TIMEOUT_IN_MS,
  ) {
    requireDeadlines(timeout, leaseTimeout);
    this.#timeout = timeout;
    this.#connections = new SessionConnections(pool, timeout, leaseTimeout);
  }

  async read(key: string): Promise<StoredSession | null> {
    keyCheck(key);
    const client = await this.#connections.connect();
    let failed = false;
    try {
      const result = await boundedOperation(
        client.query("SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1", [key]),
        this.#timeout,
      );
      return stored(result.rows[0]);
    } catch (cause) {
      failed = true;
      throw new SessionError("session_store", "Session lookup failed", cause);
    } finally {
      client.release(failed);
    }
  }

  async exclusive<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
    keyCheck(key);
    // One local caller per key borrows a connection; later callers wait here, not in the pool.
    if (this.#queued >= MAX_QUEUED_OWNERS)
      throw new SessionError("session_capacity", "Session owner queue capacity reached");
    this.#queued++;
    const deadline = Date.now() + this.#timeout,
      previous = this.#queues.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const tail = previous.then(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    try {
      await boundedOperation(previous, this.#timeout, "Session lock acquisition timed out");
      return await ownLease(this.#connections, { key, deadline }, work);
    } finally {
      this.#queued--;
      void previous.then(() => finish());
    }
  }
}
