import { encodeJson } from "../core/json.js";
import { isBrowser } from "../core/jwt.js";
import { BrowserSessionState } from "./browser/state.js";
/** Where the session lives: the adapter, its native journal and the local copy. No timers, locks or events. */
import { memoryStorage, parseSession, type Session, type SessionStorage } from "./session.js";

function browserStorage(): SessionStorage | undefined {
  try {
    return isBrowser() ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function storageKey(url: URL): string {
  const pathname = url.pathname;
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === "/") end--;
  return `nelcota.${url.host}${pathname.slice(0, end)}.session`;
}

export class SessionStore {
  // Shared with the OAuth verifier, using a distinct key suffix.
  readonly storage: SessionStorage;
  readonly #native: BrowserSessionState | undefined;
  readonly #pkce: BrowserSessionState | undefined;
  #session: Session | null | undefined;
  // The local copy is newer than storage until a persistence attempt succeeds.
  dirty = false;
  #revision = 0;

  constructor(
    readonly key: string,
    storage?: SessionStorage,
  ) {
    const native = browserStorage();
    this.storage = storage ?? native ?? memoryStorage();
    if (native != null && this.storage === native) {
      let factory: IDBFactory | undefined;
      try {
        factory = globalThis.indexedDB;
      } catch {
        /* Report unavailable storage on the first operation. */
      }
      this.#native = new BrowserSessionState(key, factory);
      this.#pkce = new BrowserSessionState(`${key}.pkce`, factory);
    }
  }

  get session(): Session | null | undefined {
    return this.#session;
  }
  /** Native browser storage: the IndexedDB journal is authoritative, not the local copy. */
  get journaled(): boolean {
    return this.#native !== undefined;
  }
  /** Another client reserved the stored token and has not published its replacement. */
  get pending(): boolean {
    return this.#native?.pending ?? false;
  }
  get journalRevision(): string | undefined {
    return this.#native?.revision;
  }
  /** Changes whenever this client or the journal publishes a different state. */
  get revision(): string {
    return `${this.#revision}/${this.#native?.revision}`;
  }

  async read(force = false, allowPending = false): Promise<Session | null> {
    // Storage may still contain a spent token or a session already signed out.
    // Keep the newer local state until a later persistence attempt succeeds.
    if (this.#keepLocal(force)) return this.#session ?? null;
    const stored = await this.#stored(allowPending);
    this.#session = parseSession(stored);
    if (stored !== null && this.#session === null) {
      await this.#native?.write(null);
      await this.storage.removeItem(this.key);
    }
    return this.#session;
  }
  #keepLocal(force: boolean): boolean {
    return this.#native == null && (this.dirty || (force === false && this.#session !== undefined));
  }
  async #stored(allowPending: boolean): Promise<string | null> {
    if (this.#native == null) return await this.storage.getItem(this.key);
    const snapshot = await this.#native.read(
      () => this.#nativeValue(this.key),
      this.#pendingSnapshot(),
      allowPending,
    );
    this.dirty = snapshot.retainDirty;
    return snapshot.value;
  }
  /** A local publication overrides the journal only while it is pending. */
  #pendingSnapshot(): string | null | undefined {
    if (this.dirty === false) return undefined;
    return this.#session == null ? null : encodeJson(this.#session);
  }
  #nativeValue(key: string): string | null {
    const value = this.storage.getItem(key);
    if (value !== null && typeof value !== "string")
      throw new Error("Native browser storage must be synchronous");
    return value;
  }
  /** Adopts a new local state ahead of persistence; it stays dirty until `persist()` succeeds. */
  adopt(session: Session | null): void {
    this.#revision++;
    this.#session = session;
    this.dirty = true;
  }
  /** Forgets local state that lost ownership; the next read is authoritative. */
  discard(): void {
    this.#session = null;
    this.dirty = false;
  }
  async persist(encoded?: string, completingRefresh = false): Promise<void> {
    const session = this.#session;
    await this.#native?.write(
      session != null ? (encoded ?? encodeJson(session)) : null,
      completingRefresh,
    );
    await (session != null
      ? this.storage.setItem(this.key, encoded ?? encodeJson(session))
      : this.storage.removeItem(this.key));
    this.dirty = false;
  }
  /**
   * The stored session without waiting for a lock. This is only a comparison
   * hint: read before waiting, since a locked read could observe another
   * rotation's replacement. Locked reads remain the authority for mutations.
   */
  hint(): Session | null {
    if (this.#native == null || this.dirty) return this.#session ?? null;
    try {
      return parseSession(this.#nativeValue(this.key)) ?? this.#session ?? null;
    } catch {
      return this.#session ?? null;
    }
  }
  /** Commits a reservation before HTTP so no other client spends the same token. */
  async reserve(session: Session): Promise<void> {
    await this.#native?.reserve(session);
  }
  /** Gives back a reservation whose rotation definitely did not commit. */
  async release(session: Session): Promise<void> {
    await this.#native?.write(encodeJson(session), true);
  }

  async setVerifier(value: string): Promise<void> {
    const key = `${this.key}.pkce`;
    await this.#pkce?.write(value);
    await this.storage.setItem(key, value);
  }
  async consumeVerifier(): Promise<string | null> {
    const key = `${this.key}.pkce`;
    const value =
      this.#pkce != null
        ? await this.#pkce.consume(() => this.#nativeValue(key))
        : await this.storage.getItem(key);
    await this.storage.removeItem(key);
    return value;
  }
}
