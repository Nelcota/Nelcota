import { promiseResult } from "../src/lifecycle/promise-result.js";
import type { SessionConnection, SessionPool } from "../src/postgres.js";

type QueryResult = Awaited<ReturnType<SessionConnection["query"]>>;
const POLL_IN_MS = 1;
const DEFAULT_POOL_SIZE = 10;

/** A PostgreSQL error as node-postgres reports it. */
function databaseError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function timeoutInMs(setting: string): number {
  const match = /^(\d+)(ms)?$/.exec(setting);
  if (match === null) throw new Error(`Unexpected statement_timeout: ${setting}`);
  return Number(match[1]);
}

/** In-memory stand-in for the statements PostgresSessionStore issues.
 * Session advisory locks are owned per backend (re-entrant, counted) and are
 * dropped only when a backend is destroyed. Like node-postgres, a released
 * backend returns to its pool and the next borrower reuses it, together with
 * its session settings and any lock it still holds. `statement_timeout`
 * cancels a lock wait with SQLSTATE 57014.
 */
export class FakePostgres {
  readonly rows: Map<string, { sealed: string; expires_at: string }> = new Map();
  readonly #locks = new Map<string, { owner: number; count: number }>();
  /** Backends returned to a pool while still holding an advisory lock. */
  readonly leakedLocks: number[] = [];
  /** statement_timeout per backend, kept across borrowers like a pooled session. */
  readonly #timeouts = new Map<number, string>();
  #next = 0;

  pool(max = DEFAULT_POOL_SIZE): SessionPool & { idle: number[]; borrowed: Set<number> } {
    const idle: number[] = [];
    const borrowed = new Set<number>();
    const waiting: (() => void)[] = [];
    const borrow = (): SessionConnection => {
      const backend = idle.pop() ?? ++this.#next;
      borrowed.add(backend);
      return this.#connection(backend, (destroy) => {
        borrowed.delete(backend);
        if (destroy) this.#dropLocks(backend);
        else {
          if (this.#holdsLock(backend)) this.leakedLocks.push(backend);
          idle.push(backend);
        }
        waiting.shift()?.();
      });
    };
    return {
      idle,
      borrowed,
      options: { max },
      connect: () => {
        if (borrowed.size < max) return promiseResult(borrow);
        return new Promise((resolve) => {
          waiting.push(() => resolve(borrow()));
        });
      },
    };
  }

  /** The session statement_timeout a backend currently carries. */
  statementTimeout(id: number): string {
    return this.#timeouts.get(id) ?? "0";
  }

  /** Advisory locks currently held, by backend id. */
  heldBy(id: number): string[] {
    return [...this.#locks].filter(([, held]) => held.owner === id).map(([key]) => key);
  }

  #holdsLock(id: number): boolean {
    return this.heldBy(id).length > 0;
  }
  #dropLocks(id: number): void {
    for (const key of this.heldBy(id)) this.#locks.delete(key);
  }

  #connection(backend: number, done: (destroy: boolean) => void): SessionConnection {
    let released = false;
    return {
      query: async (text, values = []) => {
        await Promise.resolve();
        if (released) throw new Error("Query on a released client");
        const key = String(values[0]);
        if (text.includes("current_setting"))
          return { rows: [{ timeout: this.statementTimeout(backend) }] };
        if (text.includes("set_config")) {
          this.#timeouts.set(backend, key);
          return { rows: [] };
        }
        if (text.includes("pg_advisory_unlock_all")) {
          this.#dropLocks(backend);
          return { rows: [] };
        }
        return await this.#statement(backend, { text, key, values });
      },
      release: (destroy) => {
        if (released) throw new Error("Client released twice");
        released = true;
        done(destroy === true);
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
  }

  async #lock(backend: number, key: string): Promise<QueryResult> {
    const limit = timeoutInMs(this.statementTimeout(backend)),
      started = Date.now();
    while (this.#locks.has(key) && this.#locks.get(key)?.owner !== backend) {
      if (limit > 0 && Date.now() - started >= limit)
        throw databaseError("canceling statement due to statement timeout", "57014");
      // oxlint-disable-next-line no-await-in-loop -- Advance the bounded lock poll only after the current wait has completed.
      await new Promise((resolve) => setTimeout(resolve, POLL_IN_MS));
    }
    const held = this.#locks.get(key);
    this.#locks.set(key, { owner: backend, count: (held?.count ?? 0) + 1 });
    return { rows: [] };
  }
  #tryLock(id: number, key: string): QueryResult {
    const held = this.#locks.get(key);
    if (held != null && held.owner !== id) return { rows: [{ locked: false }] };
    this.#locks.set(key, { owner: id, count: (held?.count ?? 0) + 1 });
    return { rows: [{ locked: true }] };
  }
  #unlock(id: number, key: string): QueryResult {
    const held = this.#locks.get(key);
    if (held == null || held.owner !== id) return { rows: [{ released: false }] };
    if (held.count === 1) this.#locks.delete(key);
    if (held.count > 1) held.count--;
    return { rows: [{ released: true }] };
  }
  async #statement(
    backend: number,
    statement: { text: string; key: string; values: unknown[] },
  ): Promise<QueryResult> {
    const { text, key, values } = statement;
    if (text.includes("pg_advisory_lock(")) return await this.#lock(backend, key);
    if (text.includes("pg_try_advisory_lock")) return this.#tryLock(backend, key);
    if (text.includes("pg_advisory_unlock")) return this.#unlock(backend, key);
    if (text.startsWith("SELECT sealed")) {
      const row = this.rows.get(key);
      return { rows: row != null ? [{ ...row }] : [] };
    }
    if (text.startsWith("INSERT")) {
      this.rows.set(key, { sealed: String(values[1]), expires_at: String(values[2]) });
      return { rows: [] };
    }
    if (text.startsWith("DELETE")) {
      this.rows.delete(key);
      return { rows: [] };
    }
    throw new Error(`Unexpected statement: ${text}`);
  }
}
