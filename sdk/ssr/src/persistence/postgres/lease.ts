import { SessionError } from "../../errors.js";
import type { SessionLease, StoredSession } from "../../store.js";
import type { SessionConnections } from "./connections.js";
import { boundedOperation } from "./deadlines.js";
import { keyCheck, requireBoundedState, stored } from "./rows.js";
import type { OwnedConnection, OwnershipRequest } from "./types.js";

const QUERY_DEADLINE_MARGIN_IN_MS = 25;

/** One connection owns every lock and statement until cleanup or destruction. */
class ConnectionOwner {
  readonly #connections: SessionConnections;
  readonly #request: OwnershipRequest;
  readonly #client: OwnedConnection;
  readonly #held: string[];
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
    if (
      (await this.#query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [next]))
        .rows[0]?.["locked"] !== true
    )
      throw new SessionError("session_store", "Fresh session key is already owned");
    this.#held.push(next);
    if (retain != null) await this.#upsert(this.#current, retain);
    if (retain == null)
      await this.#query("DELETE FROM nelcota_next.sessions WHERE key = $1", [this.#current]);
    this.#current = next;
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
        this.#client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released", [key]),
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
    await this.#query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [this.#request.key]);
    this.#locked = true;
    await this.#query("SELECT set_config('statement_timeout', $1, false)", [previous]);
    this.#authDeadline = Date.now() + this.#connections.leaseTimeout - this.#connections.timeout;
  }

  async run<T>(work: (lease: SessionLease) => Promise<T>): Promise<T> {
    try {
      await this.#acquire();
      return await boundedOperation(
        Promise.resolve().then(() => work(this.#lease)),
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
