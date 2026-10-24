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
 * Same-key callers queue in-process before borrowing. PostgreSQL queues lock
 * waiters fairly; a server-side statement timeout bounds every acquisition.
 */
export class PostgresSessionStore implements SessionStore {
  readonly durability = 'shared' as const;
  readonly #pool: SessionPool;
  #connecting = 0;
  #borrowed = 0;
  #queued = 0;
  readonly #queues = new Map<string, Promise<void>>();
  constructor(pool: SessionPool, private readonly timeout = 5000, private readonly leaseTimeout = 60000) {
    this.#pool = pool;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000 || !Number.isSafeInteger(leaseTimeout) || leaseTimeout < 2 * timeout || leaseTimeout > 120000) throw new SessionError('configuration', 'Invalid session store deadlines');
  }
  async #bounded<T>(operation: Promise<T>, timeout = this.timeout, message = 'Session store deadline exceeded'): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SessionError('session_store', message)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  async #connect(timeout = this.timeout): Promise<OwnedConnection> {
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
          const destroyed = destroy === true || connection.signal.aborted;
          // A destroyed client can still emit its terminal FATAL; keep it observed.
          try { client.release(destroyed); }
          finally { if (!destroyed) client.removeListener('error', lost); }
        },
      };
    }, error => { this.#connecting--; throw error; });
    try { return await this.#bounded(pending, Math.min(timeout, this.timeout)); }
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
    // One local caller per key borrows a connection; later callers wait here, not in the pool.
    if (this.#queued >= 256) throw new SessionError('session_capacity', 'Session owner queue capacity reached');
    this.#queued++;
    const deadline = Date.now() + this.timeout, previous = this.#queues.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const tail = previous.then(() => new Promise<void>(resolve => { finish = resolve; }));
    this.#queues.set(key, tail);
    void tail.then(() => { if (this.#queues.get(key) === tail) this.#queues.delete(key); });
    try {
      await this.#bounded(previous, this.timeout, 'Session lock acquisition timed out');
      return await this.#owned(key, work, deadline);
    } finally { this.#queued--; void previous.then(() => finish()); }
  }
  async #owned<T>(key: string, work: (lease: SessionLease) => Promise<T>, deadline: number, borrowed?: OwnedConnection): Promise<T> {
    const client = borrowed ?? await this.#connect(Math.max(1, deadline - Date.now()));
    let active = true, locked = false, failed = false, workFailed = false, current = key;
    const held = [key];
    let authDeadline = Number.POSITIVE_INFINITY;
    const lifetime = new AbortController();
    const lost = (): void => { failed = true; lifetime.abort(); };
    client.signal.addEventListener('abort', lost, { once: true });
    if (client.signal.aborted) lost();
    const query = async (sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      if (!active || failed) throw new SessionError('closed_context', 'The session owner is no longer active');
      try { return await this.#bounded(client.query(sql, values)); }
      catch (cause) { failed = true; lifetime.abort(); throw new SessionError('session_store', 'Session persistence failed', cause); }
    };
    const bounded = (value: StoredSession): void => {
      if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.sealed.length > 131072) throw new SessionError('invalid_session', 'Invalid bounded session state');
    };
    const upsert = async (target: string, value: StoredSession): Promise<void> => {
      bounded(value);
      await query('INSERT INTO nelcota_next.sessions (key, sealed, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at', [target, value.sealed, value.expiresAt]);
    };
    const lease: SessionLease = {
      signal: lifetime.signal,
      // Reserve one query deadline after the last auth response for its save.
      get deadline() { return authDeadline; },
      read: async target => { keyCheck(target); return stored((await query('SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1', [target])).rows[0]); },
      exclusive: async (target, nested) => {
        keyCheck(target);
        if (!active || failed || lifetime.signal.aborted) throw new SessionError('closed_context', 'The session owner is no longer active');
        if (held.includes(target)) throw new SessionError('session_store', 'Nested session key is already owned');
        try { return await this.#owned(target, nested, Math.min(Date.now() + this.timeout, authDeadline), { ...client, signal: AbortSignal.any([client.signal, lifetime.signal]) }); }
        catch (cause) { failed = true; lifetime.abort(); throw cause; }
      },
      load: async () => stored((await query('SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key = $1', [current])).rows[0]),
      save: async value => { await upsert(current, value); },
      remove: async () => { await query('DELETE FROM nelcota_next.sessions WHERE key = $1', [current]); },
      rotate: async (next, retain) => {
        keyCheck(next);
        if (retain) bounded(retain);
        if ((await query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [next])).rows[0]?.['locked'] !== true) throw new SessionError('session_store', 'Fresh session key is already owned');
        held.push(next);
        if (retain) await upsert(current, retain);
        if (!retain) await query('DELETE FROM nelcota_next.sessions WHERE key = $1', [current]);
        current = next;
      },
    };
    try {
      // Polling permits a hot local queue to starve other app instances. Join
      // PostgreSQL's lock wait queue, with its own deadline as well as ours.
      const previous = (await query("SELECT current_setting('statement_timeout') AS timeout")).rows[0]?.['timeout'];
      if (typeof previous !== 'string') throw new SessionError('session_store', 'Session statement timeout is unavailable');
      const remaining = deadline - Date.now() - 25;
      if (remaining <= 0) throw new SessionError('session_store', 'Session lock acquisition timed out');
      await query("SELECT set_config('statement_timeout', $1, false)", [`${remaining}ms`]);
      await query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      locked = true;
      // Restore the caller's session setting before auth or persistence work.
      // Any failed query poisons/destroys this connection instead of pooling it.
      await query("SELECT set_config('statement_timeout', $1, false)", [previous]);
      authDeadline = Date.now() + this.leaseTimeout - this.timeout;
      return await this.#bounded(Promise.resolve().then(() => work(lease)), this.leaseTimeout);
    } catch (cause) {
      workFailed = true;
      if (locked && cause instanceof SessionError && cause.code === 'session_store') failed = true;
      throw cause;
    } finally {
      active = false; lifetime.abort();
      client.signal.removeEventListener('abort', lost);
      let cleanupError: unknown;
      if (locked && !failed) {
        try {
          for (const owned of held) {
            const result = await this.#bounded(client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [owned]));
            if (result.rows[0]?.['released'] !== true) throw new SessionError('session_store', 'Session lock ownership was lost');
          }
        } catch (cause) { failed = true; cleanupError = cause; }
      }
      // A failed query/unlock must not return a lock-holding connection to a pool.
      if (!borrowed) client.release(failed);
      if (failed && !workFailed && !cleanupError) throw new SessionError('session_store', 'Session owner lost persistence');
      if (cleanupError && !workFailed) throw new SessionError('session_store', 'Session lock release failed', cleanupError);
    }
  }
}
