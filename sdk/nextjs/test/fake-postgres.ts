import type { SessionConnection, SessionPool } from '../src/postgres.js';

/** In-memory stand-in for the five statements PostgresSessionStore issues.
 * Session advisory locks are owned per connection (re-entrant, counted) and
 * are dropped when a connection is destroyed, as in PostgreSQL.
 */
export class FakePostgres {
  readonly rows: Map<string, { sealed: string; expires_at: string }> = new Map();
  readonly #locks = new Map<string, { owner: number; count: number }>();
  #next = 0;
  pool(): SessionPool {
    return { connect: async () => this.#connection(++this.#next) };
  }
  #connection(id: number): SessionConnection {
    return {
      query: async (text, values = []) => {
        await Promise.resolve();
        const key = String(values[0]);
        if (text.includes('pg_try_advisory_lock')) {
          const held = this.#locks.get(key);
          if (held && held.owner !== id) return { rows: [{ locked: false }] };
          this.#locks.set(key, { owner: id, count: (held?.count ?? 0) + 1 });
          return { rows: [{ locked: true }] };
        }
        if (text.includes('pg_advisory_unlock')) {
          const held = this.#locks.get(key);
          if (!held || held.owner !== id) return { rows: [{ released: false }] };
          if (held.count === 1) this.#locks.delete(key);
          if (held.count > 1) held.count--;
          return { rows: [{ released: true }] };
        }
        if (text.startsWith('SELECT sealed')) {
          const row = this.rows.get(key);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (text.startsWith('INSERT')) { this.rows.set(key, { sealed: String(values[1]), expires_at: String(values[2]) }); return { rows: [] }; }
        if (text.startsWith('DELETE')) { this.rows.delete(key); return { rows: [] }; }
        throw new Error(`Unexpected statement: ${text}`);
      },
      release: destroy => {
        if (!destroy) return;
        for (const [key, held] of this.#locks) if (held.owner === id) this.#locks.delete(key);
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
  }
}
