import { SessionError } from "./errors.js";
import { promiseResult } from "./lifecycle/promise-result.js";
import type { SessionLease, SessionStore, StoredSession } from "./store.js";
const DEFAULT_SESSION_CAPACITY = 1000;
const MAX_SESSION_CAPACITY = 10000;
const MAX_SEALED_SESSION_CHARS = 131072;
const MAX_QUEUED_OWNERS = 256;

/** Explicit development/test store. It loses sessions on restart and is not shared. */
export class DevelopmentSessionStore implements SessionStore {
  readonly durability = "development" as const;
  readonly #sessions = new Map<string, StoredSession>();
  #waiting = 0;
  readonly #pending = new Map<string, Promise<void>>();
  constructor(readonly capacity: number = DEFAULT_SESSION_CAPACITY) {
    if (
      Number.isSafeInteger(capacity) === false ||
      capacity < 1 ||
      capacity > MAX_SESSION_CAPACITY
    ) {
      throw new SessionError(
        "configuration",
        "Session capacity must be an integer from 1 to 10000",
      );
    }
  }
  read(key: string): Promise<StoredSession | null> {
    return promiseResult(() => {
      const value = this.#sessions.get(key);
      if (value == null) return null;
      if (value.expiresAt <= Date.now()) {
        this.#sessions.delete(key);
        return null;
      }
      return { ...value };
    });
  }
  #put(key: string, value: StoredSession): void {
    if (
      Number.isSafeInteger(value.expiresAt) === false ||
      value.expiresAt <= Date.now() ||
      value.sealed.length > MAX_SEALED_SESSION_CHARS
    ) {
      throw new SessionError("invalid_session", "Invalid bounded session state");
    }
    if (this.#sessions.has(key) === false && this.#sessions.size >= this.capacity) {
      this.#pruneExpired();
      if (this.#sessions.size >= this.capacity)
        throw new SessionError("session_capacity", "Development session capacity reached");
    }
    this.#sessions.set(key, { ...value });
  }
  #pruneExpired(): void {
    for (const [id, row] of this.#sessions) {
      if (row.expiresAt <= Date.now()) this.#sessions.delete(id);
    }
  }
  async exclusive<T>(key: string, work: (lease: SessionLease) => Promise<T>): Promise<T> {
    if (this.#waiting >= MAX_QUEUED_OWNERS)
      throw new SessionError("session_capacity", "Development owner capacity reached");
    this.#waiting++;
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const { lease, close } = this.#lease(key);
    const running = previous.then(() => work(lease));
    const tail = running.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.set(key, tail);
    try {
      return await running;
    } finally {
      this.#waiting--;
      close();
      if (this.#pending.get(key) === tail) this.#pending.delete(key);
    }
  }
  #lease(key: string): { lease: SessionLease; close: () => void } {
    let active = true,
      current = key;
    const lifetime = new AbortController();
    const requireOwner = (): void => {
      if (active === false)
        throw new SessionError("closed_context", "The session context has ended");
    };
    const lease: SessionLease = {
      signal: lifetime.signal,
      deadline: Number.POSITIVE_INFINITY,
      load: async () => {
        requireOwner();
        return await this.read(current);
      },
      save: (value) => {
        return promiseResult(() => {
          requireOwner();
          this.#put(current, value);
        });
      },
      remove: () => {
        return promiseResult(() => {
          requireOwner();
          this.#sessions.delete(current);
        });
      },
      rotate: (next, retain) => {
        return promiseResult(() => {
          requireOwner();
          if (retain != null) this.#put(current, retain);
          if (retain == null) this.#sessions.delete(current);
          current = next;
        });
      },
    };
    return {
      lease,
      close: () => {
        active = false;
        lifetime.abort();
      },
    };
  }
}
