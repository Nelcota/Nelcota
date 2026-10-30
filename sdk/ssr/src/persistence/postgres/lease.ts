import { SessionError } from "../../errors.js";
import type { SessionLease, StoredSession } from "../../store.js";
import type { SessionConnections } from "./connections.js";
import { boundedOperation } from "./deadlines.js";
import { keyCheck, requireBoundedState, stored } from "./rows.js";
import type { OwnedConnection, OwnershipRequest } from "./types.js";

const QUERY_DEADLINE_MARGIN_IN_MS = 25;
// Frozen lock key: 0.1.x instances lock the same single-bigint key, so old and new
// instances exclude each other during a rolling deploy. The key space is shared
// with any other pg_advisory_lock(bigint) user of the database; a collision only
// serializes unrelated work, and a dedicated session database avoids it.
const LOCK = "pg_advisory_lock(hashtextextended($1, 0))";
const TRY_LOCK = "pg_try_advisory_lock(hashtextextended($1, 0))";
const UNLOCK = "pg_advisory_unlock(hashtextextended($1, 0))";
const QUERY_CANCELED = "57014";

function queryCanceled(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === QUERY_CANCELED
  );
}

/** One connection owns every lock and statement until cleanup or destruction. */
class ConnectionOwner {
  readonly #connections: SessionConnections;
  readonly #request: OwnershipRequest;
  readonly #client: OwnedConnection;
  readonly #held: string[];
  /** Rows rotated away from, replaced only once the callback has succeeded. */
  readonly #rotated: { key: string; retain: StoredSession | undefined }[] = [];
  readonly #lifetime = new AbortController();
  #active = true;
  #locked = false;
  #failed = false;
  #workFailed = false;
  #current: string;
  #authDeadline = Number.POSITIVE_INFINITY;
  readonly #lost = (): void => {
    this.#failed = true;
    this.#lifetime.abort();
  };

  constructor(connections: SessionConnections, request: OwnershipRequest, client: OwnedConnection) {
    this.#connections = connections;
    this.#request = request;
    this.#client = client;
    this.#current = request.key;
    this.#held = [request.key];
    client.signal.addEventListener("abort", this.#lost, { once: true });
    if (client.signal.aborted) this.#lost();
  }

  async #query(sql: string, values?: unknown[]): ReturnType<OwnedConnection["query"]> {
    if (this.#active === false || this.#failed)
      throw new SessionError("closed_context", "The session owner is no longer active");
    try {
      return await boundedOperation(this.#client.query(sql, values), this.#connections.timeout);
    } catch (cause) {
      this.#lost();
      throw new SessionError("session_store", "Session persistence failed", cause);
    }
  }

  async #upsert(target: string, value: StoredSession): Promise<void> {
    requireBoundedState(value);
    await this.#query(
      "INSERT INTO nelcota_next.sessions (key, sealed, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at",
      [target, value.sealed, value.expiresAt],
    );
  }

  async #read(target: string): Promise<StoredSession | null> {
    return stored(
      (
        await this.#query("SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1", [
          target,
        ])
      ).rows[0],
    );
  }

  async #nested<T>(target: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
    keyCheck(target);
    if (this.#active === false || this.#failed || this.#lifetime.signal.aborted)
      throw new SessionError("closed_context", "The session owner is no longer active");
    if (this.#held.includes(target))
      throw new SessionError("session_store", "Nested session key is already owned");
    try {
      return await ownLease(
        this.#connections,
        {
          key: target,
          deadline: Math.min(Date.now() + this.#connections.timeout, this.#authDeadline),
          borrowed: {
            ...this.#client,
            signal: AbortSignal.any([this.#client.signal, this.#lifetime.signal]),
          },
        },
        work,
      );
    } catch (cause) {
      this.#lost();
      throw cause;
    }
  }

  async #rotate(next: string, retain?: StoredSession): Promise<void> {
    keyCheck(next);
    if (retain != null) requireBoundedState(retain);
    if ((await this.#query(`SELECT ${TRY_LOCK} AS locked`, [next])).rows[0]?.["locked"] !== true)
      throw new SessionError("session_store", "Fresh session key is already owned");
    this.#held.push(next);
    this.#rotated.push({ key: this.#current, retain });
    this.#current = next;
  }

  /** Publication order: the new row and lineage head are written by the callback;
   * only after it succeeded is the previous row replaced (tombstone) or removed. */
  async #retireRotated(): Promise<void> {
    for (const { key, retain } of this.#rotated) {
      // oxlint-disable-next-line no-await-in-loop -- Replace rotated rows in rotation order on the owning connection.
      if (retain != null) await this.#upsert(key, retain);
      // oxlint-disable-next-line no-await-in-loop -- Replace rotated rows in rotation order on the owning connection.
      else await this.#query("DELETE FROM nelcota_next.sessions WHERE key = $1", [key]);
    }
  }

  get #lease(): SessionLease {
    const deadline = (): number => this.#authDeadline;
    return {
      signal: this.#lifetime.signal,
      get deadline() {
        return deadline();
      },
      read: async (target) => {
        keyCheck(target);
        return await this.#read(target);
      },
      exclusive: (target, work) => this.#nested(target, work),
      load: () => this.#read(this.#current),
      save: (value) => this.#upsert(this.#current, value),
      remove: async () => {
        await this.#query("DELETE FROM nelcota_next.sessions WHERE key = $1", [this.#current]);
      },
      rotate: (next, retain) => this.#rotate(next, retain),
    };
  }

  async #unlockHeld(): Promise<void> {
    for (const key of this.#held) {
      // oxlint-disable-next-line no-await-in-loop -- Release locks on their owning connection in order; stop on the first lost-ownership failure.
      const result = await boundedOperation(
        this.#client.query(`SELECT ${UNLOCK} AS released`, [key]),
        this.#connections.timeout,
      );
      if (result.rows[0]?.["released"] !== true)
        throw new SessionError("session_store", "Session lock ownership was lost");
    }
  }

  async #release(): Promise<void> {
    this.#active = false;
    this.#lifetime.abort();
    this.#client.signal.removeEventListener("abort", this.#lost);
    let cleanupError: unknown;
    if (this.#locked && this.#failed === false) {
      try {
        await this.#unlockHeld();
      } catch (cause) {
        this.#failed = true;
        cleanupError = cause;
      }
    }
    // Never return a connection with uncertain lock ownership to its pool.
    if (this.#request.borrowed === undefined) this.#client.release(this.#failed);
    if (this.#failed && this.#workFailed === false && Boolean(cleanupError) === false)
      throw new SessionError("session_store", "Session owner lost persistence");
    if (Boolean(cleanupError) && this.#workFailed === false)
      throw new SessionError("session_store", "Session lock release failed", cleanupError);
  }

  async #acquire(): Promise<void> {
    // Join the server's fair lock queue, bounded by both statement and local deadlines.
    const previous = (await this.#query("SELECT current_setting('statement_timeout') AS timeout"))
      .rows[0]?.["timeout"];
    if (typeof previous !== "string")
      throw new SessionError("session_store", "Session statement timeout is unavailable");
    const remaining = this.#request.deadline - Date.now() - QUERY_DEADLINE_MARGIN_IN_MS;
    if (remaining <= 0)
      throw new SessionError("session_store", "Session lock acquisition timed out");
    await this.#query("SELECT set_config('statement_timeout', $1, false)", [`${remaining}ms`]);
    try {
      // The server cancels the wait first (57014); the local bound only catches a
      // server that stopped answering, after which the connection is unusable.
      await boundedOperation(
        this.#client.query(`SELECT ${LOCK}`, [this.#request.key]),
        remaining + this.#connections.timeout,
      );
    } catch (cause) {
      if (queryCanceled(cause)) await this.#abandonWait(previous, cause);
      this.#lost();
      throw new SessionError("session_store", "Session persistence failed", cause);
    }
    this.#locked = true;
    await this.#query("SELECT set_config('statement_timeout', $1, false)", [previous]);
    this.#authDeadline = Date.now() + this.#connections.leaseTimeout - this.#connections.timeout;
  }

  /** A cancelled lock wait is an ordinary timeout: restore the session setting and
   * keep the connection poolable. A nested owner shares its parent's locks, so it
   * cannot prove it holds none and the parent discards the connection instead.
   * `pg_advisory_unlock_all` covers a grant racing the cancel: the pool must never
   * receive a connection holding a lock, since its next borrower would re-enter it.
   */
  async #abandonWait(previous: string, cause: unknown): Promise<never> {
    if (this.#request.borrowed === undefined) {
      await this.#query("SELECT set_config('statement_timeout', $1, false)", [previous]);
      await this.#query("SELECT pg_advisory_unlock_all()");
      throw new SessionError("session_store", "Session lock acquisition timed out", cause);
    }
    this.#lost();
    throw new SessionError("session_store", "Session lock acquisition timed out", cause);
  }

  async run<T>(work: (lease: SessionLease) => Promise<T>): Promise<T> {
    try {
      await this.#acquire();
      return await boundedOperation(
        Promise.resolve()
          .then(() => work(this.#lease))
          .then(async (result) => {
            await this.#retireRotated();
            return result;
          }),
        this.#connections.leaseTimeout,
      );
    } catch (cause) {
      this.#workFailed = true;
      if (this.#locked && cause instanceof SessionError && cause.code === "session_store")
        this.#failed = true;
      throw cause;
    } finally {
      await this.#release();
    }
  }
}

export async function ownLease<T>(
  connections: SessionConnections,
  request: OwnershipRequest,
  work: (lease: SessionLease) => Promise<T>,
): Promise<T> {
  const client =
    request.borrowed ?? (await connections.connect(Math.max(1, request.deadline - Date.now())));
  return await new ConnectionOwner(connections, request, client).run(work);
}
