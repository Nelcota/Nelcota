import { SessionError } from './errors.js';
import type { SessionLease, SessionStore, StoredSession } from './store.js';

/** Explicit development/test store. It loses sessions on restart and is not shared. */
export class DevelopmentSessionStore implements SessionStore {
  readonly durability = 'development' as const;
  readonly #sessions = new Map<string, StoredSession>();
  #waiting = 0;
  readonly #pending = new Map<string, Promise<void>>();
  constructor(readonly capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) {
      throw new SessionError('configuration', 'Session capacity must be an integer from 1 to 10000');
    }
  }
  async read(key: string): Promise<StoredSession | null> {
    const value = this.#sessions.get(key);
    if (!value) return null;
    if (value.expiresAt <= Date.now()) { this.#sessions.delete(key); return null; }
    return { ...value };
  }
  #put(key: string, value: StoredSession): void {
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.sealed.length > 131072) {
      throw new SessionError('invalid_session', 'Invalid bounded session state');
    }
    if (!this.#sessions.has(key) && this.#sessions.size >= this.capacity) {
      for (const [id, row] of this.#sessions) if (row.expiresAt <= Date.now()) this.#sessions.delete(id);
      if (this.#sessions.size >= this.capacity) throw new SessionError('session_capacity', 'Development session capacity reached');
    }
    this.#sessions.set(key, { ...value });
  }
  async exclusive<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
    if (this.#waiting >= 256) throw new SessionError('session_capacity', 'Development owner capacity reached');
    this.#waiting++;
    const previous = this.#pending.get(key) ?? Promise.resolve();
    let active = true, current = key;
    const lifetime = new AbortController();
    const requireOwner = (): void => {
      if (!active) throw new SessionError('closed_context', 'The session context has ended');
    };
    const lease: SessionLease = {
      signal: lifetime.signal,
      deadline: Number.POSITIVE_INFINITY,
      load: async () => { requireOwner(); return this.read(current); },
      save: async value => { requireOwner(); this.#put(current, value); },
      remove: async () => { requireOwner(); this.#sessions.delete(current); },
      rotate: async (next, retain) => {
        requireOwner();
        if (retain) this.#put(current, retain);
        if (!retain) this.#sessions.delete(current);
        current = next;
      },
    };
    const running = previous.then(() => work(lease));
    const tail = running.then(() => undefined, () => undefined);
    this.#pending.set(key, tail);
    try { return await running; }
    finally {
      this.#waiting--;
      active = false; lifetime.abort();
      if (this.#pending.get(key) === tail) this.#pending.delete(key);
    }
  }
}
