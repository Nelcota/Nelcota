import { SessionError } from "../../errors.js";
import { boundedOperation, type StoreDeadlines } from "./deadlines.js";
import type { OwnedConnection, SessionConnection, SessionPool } from "./types.js";

interface LeaseWaiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Borrows pooled connections and bounds how many of them write leases may hold.
 * Reads borrow without a slot and queue in the pool, so a burst of slow writes
 * cannot take every connection away from rendering.
 */
export class SessionConnections {
  readonly #pool: SessionPool;
  readonly timeout: number;
  readonly leaseTimeout: number;
  readonly #maxLeases: number;
  #leases = 0;
  readonly #waiters: LeaseWaiter[] = [];
  constructor(pool: SessionPool, deadlines: StoreDeadlines) {
    this.#pool = pool;
    this.timeout = deadlines.timeout;
    this.leaseTimeout = deadlines.leaseTimeout;
    this.#maxLeases = deadlines.maxLeases;
  }

  /** Waits (FIFO) for a write-lease slot until `deadline`; resolves to its release. */
  async leaseSlot(deadline: number): Promise<() => void> {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#leases--;
        return;
      }
      clearTimeout(next.timer);
      next.grant();
    };
    if (this.#leases < this.#maxLeases) {
      this.#leases++;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        grant: resolve,
        timer: setTimeout(
          () => {
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) this.#waiters.splice(index, 1);
            reject(new SessionError("session_capacity", "Session store lease capacity reached"));
          },
          Math.max(0, deadline - Date.now()),
        ),
      };
      this.#waiters.push(waiter);
    });
    return release;
  }

  #accepted(client: SessionConnection): OwnedConnection {
    let released = false;
    const connection = new AbortController();
    const lost = (): void => connection.abort();
    client.on("error", lost);
    return {
      signal: connection.signal,
      query: (text, values) => {
        if (connection.signal.aborted)
          return Promise.reject(new SessionError("session_store", "Session connection was lost"));
        return client.query(text, values);
      },
      release: (destroy) => {
        if (released)
          throw new SessionError("closed_context", "Session connection already released");
        released = true;
        const destroyed = destroy === true || connection.signal.aborted;
        // Observe terminal FATAL errors from destroyed clients until the connection ends.
        try {
          client.release(destroyed);
        } finally {
          if (destroyed === false) client.removeListener("error", lost);
        }
      },
    };
  }

  async connect(timeout: number = this.timeout): Promise<OwnedConnection> {
    let connect: Promise<SessionConnection>;
    try {
      connect = this.#pool.connect();
    } catch (cause) {
      throw new SessionError("session_store", "Session connection failed", cause);
    }
    const pending = connect.then((client) => this.#accepted(client));
    try {
      return await boundedOperation(pending, Math.min(timeout, this.timeout));
    } catch (cause) {
      // A late borrow is destroyed as soon as it arrives.
      void pending.then(
        (client) => client.release(true),
        () => undefined,
      );
      throw new SessionError("session_store", "Session connection failed", cause);
    }
  }
}
