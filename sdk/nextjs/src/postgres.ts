import 'server-only';
import { SessionError } from './errors.js';
import type { SessionLease, SessionStore, StoredSession } from './store.js';

/** Compatible with a dedicated node-postgres Pool; no pg runtime dependency. */
export interface SessionConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}
interface OwnedConnection { query: SessionConnection['query']; release: SessionConnection['release']; signal: AbortSignal }
export interface SessionPool { connect(): Promise<SessionConnection> }

function keyCheck(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new SessionError('invalid_session', 'Invalid session key');
}
function stored(row: Record<string, unknown> | undefined): StoredSession | null {
  if (!row) return null;
  const raw = row['expires_at'];
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(raw))) throw new SessionError('session_store', 'Invalid session expiry');
  const expiresAt = Number(raw);
  if (typeof row['sealed'] !== 'string' || row['sealed'].length > 131072 || !Number.isSafeInteger(expiresAt)) {
    throw new SessionError('session_store', 'Invalid session store response');
  }
  if (expiresAt <= Date.now()) return null;
  return { sealed: row['sealed'], expiresAt };
}

/** Session-scoped PG locks survive awaits, and release when the connection dies.
 * Each state save commits independently before its promise resolves. Do not wrap
 * this store in an outer SQL transaction or a transaction-pooling proxy.
 */
export class PostgresSessionStore implements SessionStore {
  readonly durability = 'shared' as const;
  readonly #pool: SessionPool;
  #connecting = 0;
  #borrowed = 0;
  constructor(pool: SessionPool, private readonly timeout = 5000, private readonly leaseTimeout = 60000) {
    this.#pool = pool;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000 || !Number.isSafeInteger(leaseTimeout) || leaseTimeout < timeout || leaseTimeout > 120000) throw new SessionError('configuration', 'Invalid session store deadlines');
  }
  async #bounded<T>(operation: Promise<T>, timeout = this.timeout): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SessionError('session_store', 'Session store deadline exceeded')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  async #connect(): Promise<OwnedConnection> {
    if (this.#connecting + this.#borrowed >= 32) throw new SessionError('session_capacity', 'Session store connection capacity reached');
    this.#connecting++;
    let connect: Promise<SessionConnection>;
    try { connect = this.#pool.connect(); }
    catch (cause) { this.#connecting--; throw new SessionError('session_store', 'Session connection failed', cause); }
    const pending = connect.then(client => {
      this.#connecting--; this.#borrowed++;
      let released = false;
      const connection = new AbortController();
      const lost = (): void => connection.abort();
      client.on('error', lost);
      return {
        signal: connection.signal,
        query: (text: string, values?: unknown[]) => {
          if (connection.signal.aborted) return Promise.reject(new SessionError('session_store', 'Session connection was lost'));
          return client.query(text, values);
        },
        release: (destroy?: boolean): void => {
          if (released) throw new SessionError('closed_context', 'Session connection already released');
          released = true; this.#borrowed--;
          try { client.release(destroy === true || connection.signal.aborted); }
          finally { client.removeListener('error', lost); }
        },
      };
    }, error => { this.#connecting--; throw error; });
    try { return await this.#bounded(pending); }
    catch (cause) {
      // Keep the pending attempt counted until it settles; destroy a late borrow.
      void pending.then(client => client.release(true), () => undefined);
      throw new SessionError('session_store', 'Session connection failed', cause);
    }
  }

  async read(key: string): Promise<StoredSession | null> {
    keyCheck(key);
    const client = await this.#connect();
    let failed = false;
    try {
      const result = await this.#bounded(client.query('SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1', [key]));
      return stored(result.rows[0]);
    } catch (cause) { failed = true; throw new SessionError('session_store', 'Session lookup failed', cause); }
    finally { client.release(failed); }
  }

  async exclusive<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
    keyCheck(key);
    const client = await this.#connect();
    let active = true, locked = false, failed = false, workFailed = false;
    const lifetime = new AbortController();
    const lost = (): void => { failed = true; lifetime.abort(); };
    client.signal.addEventListener('abort', lost, { once: true });
    if (client.signal.aborted) lost();
    const query = async (sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      if (!active || failed) throw new SessionError('closed_context', 'The session owner is no longer active');
      try { return await this.#bounded(client.query(sql, values)); }
      catch (cause) { failed = true; lifetime.abort(); throw new SessionError('session_store', 'Session persistence failed', cause); }
    };
    const lease: SessionLease = {
      signal: lifetime.signal,
      load: async () => stored((await query('SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1', [key])).rows[0]),
      save: async value => {
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.sealed.length > 131072) throw new SessionError('invalid_session', 'Invalid bounded session state');
        await query('INSERT INTO nelcota_next.sessions (key, sealed, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at', [key, value.sealed, value.expiresAt]);
      },
      remove: async () => { await query('DELETE FROM nelcota_next.sessions WHERE key = $1', [key]); },
    };
    try {
      await query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      locked = true;
      return await this.#bounded(Promise.resolve().then(() => work(lease)), this.leaseTimeout);
    } catch (cause) {
      workFailed = true;
      if (cause instanceof SessionError && cause.code === 'session_store') failed = true;
      throw cause;
    } finally {
      active = false; lifetime.abort();
      client.signal.removeEventListener('abort', lost);
      let cleanupError: unknown;
      if (locked && !failed) {
        try {
          const result = await this.#bounded(client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [key]));
          if (result.rows[0]?.['released'] !== true) throw new SessionError('session_store', 'Session lock ownership was lost');
        } catch (cause) { failed = true; cleanupError = cause; }
      }
      // A failed query/unlock must not return a lock-holding connection to a pool.
      client.release(failed || !locked);
      if (failed && !workFailed && !cleanupError) throw new SessionError('session_store', 'Session owner lost persistence');
      if (cleanupError && !workFailed) throw new SessionError('session_store', 'Session lock release failed', cleanupError);
    }
  }
}
