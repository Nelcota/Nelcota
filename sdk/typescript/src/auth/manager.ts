/** One owner for session persistence, lifecycle transitions and refresh timers. */
import { isSession, memoryStorage, parseSession, secondsLeft, type Session, type SessionStorage, type User } from './session.js';
import { BrowserSessionConflictError, BrowserSessionState } from './browser-state.js';
import { Broadcast, withLock } from './coordination.js';
import { NelcotaUsageError, clientError, fail, ok, type Result } from '../core/errors.js';
import { abortable } from '../core/cancellation.js';
import { isBrowser } from '../core/jwt.js';
import { encodeJson } from '../core/json.js';

import type { AuthEvent, AuthListener, AuthOptions, AuthRequestOptions } from './types.js';
export type { AuthEvent, AuthListener, AuthOptions, AuthRequestOptions } from './types.js';

const RETRY_REFRESH_MS = 10_000;
type Authentication = Session | { user: User; session: Session | null };

function browserStorage(): SessionStorage | undefined {
  try { return isBrowser() ? globalThis.localStorage : undefined; }
  catch { return undefined; }
}

export class SessionManager {
  // Shared with the OAuth verifier store, using a distinct key suffix.
  readonly storage: SessionStorage;
  readonly key: string;
  readonly #lockName: string | symbol;
  readonly #margin: number;
  readonly #autoRefresh: boolean;
  readonly #listeners = new Set<AuthListener>();
  readonly #broadcast: Broadcast | undefined;
  readonly #native: BrowserSessionState | undefined;
  readonly #pkce: BrowserSessionState | undefined;
  readonly #onBackgroundError: AuthOptions['onBackgroundError'];
  #session: Session | null | undefined;
  #dirty = false;
  #refreshing: Promise<Result<Session>> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #revision = 0;

  constructor(url: URL, options: AuthOptions, private rotate: (token: string, options: AuthRequestOptions) => Promise<Result<Session>>) {
    const margin = options.refreshMargin ?? 60;
    if (!Number.isFinite(margin) || margin < 0) throw new NelcotaUsageError('refreshMargin must be a finite non-negative number');
    const native = browserStorage();
    this.storage = options.storage ?? native ?? memoryStorage();
    const pathname = url.pathname;
    let end = pathname.length;
    while (end > 0 && pathname[end - 1] === '/') end--;
    const path = pathname.slice(0, end);
    this.key = options.storageKey ?? `nelcota.${url.host}${path}.session`;
    this.#lockName = `${this.key}.refresh`;
    // Default server memory stores belong to separate requests. Their queues
    // must stay independent when another client holds a sign-in across HTTP.
    if (!isBrowser() && !options.storage) this.#lockName = Symbol();
    if (native && this.storage === native) {
      let factory: IDBFactory | undefined;
      try { factory = globalThis.indexedDB; } catch { /* Report unavailable storage on the first operation. */ }
      this.#native = new BrowserSessionState(this.key, factory);
      this.#pkce = new BrowserSessionState(`${this.key}.pkce`, factory);
    }
    this.#margin = margin;
    this.#autoRefresh = options.autoRefresh ?? isBrowser();
    this.#onBackgroundError = options.onBackgroundError;
    if (isBrowser()) this.#broadcast = new Broadcast(`${this.key}.channel`, () => this.#background(this.#reload()));
    if (this.#autoRefresh) this.#background(this.current().then(session => this.#schedule(session)));
  }

  onChange(listener: AuthListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: AuthEvent, session: Session | null): void {
    for (const listener of this.#listeners) {
      // Invoke now, preserving unsubscribe order; adopt both throws and promises.
      this.#background((async () => listener(event, session))(), false);
    }
  }

  #locked<T>(task: () => Promise<T>): Promise<T> {
    return withLock(this.#lockName, task);
  }
  async #read(force = false, allowPending = false): Promise<Session | null> {
    // Storage may still contain a spent token or a session already signed out.
    // Keep the newer local state until a later persistence attempt succeeds.
    if (!this.#native && (this.#dirty || (!force && this.#session !== undefined))) return this.#session ?? null;
    const stored = await this.#stored(allowPending);
    this.#session = parseSession(stored);
    if (stored !== null && this.#session === null) {
      await this.#native?.write(null);
      await this.storage.removeItem(this.key);
    }
    return this.#session;
  }
  async #stored(allowPending: boolean): Promise<string | null> {
    if (!this.#native) return this.storage.getItem(this.key);
    const snapshot = await this.#native.read(() => this.#nativeValue(this.key), this.#dirty ? (this.#session ? encodeJson(this.#session) : null) : undefined, allowPending);
    this.#dirty = snapshot.retainDirty;
    return snapshot.value;
  }
  #nativeValue(key: string): string | null {
    const value = this.storage.getItem(key);
    if (value !== null && typeof value !== 'string') throw new Error('Native browser storage must be synchronous');
    return value;
  }
  async setVerifier(value: string): Promise<void> {
    const key = `${this.key}.pkce`;
    await this.#pkce?.write(value);
    await this.storage.setItem(key, value);
  }
  async consumeVerifier(): Promise<string | null> {
    const key = `${this.key}.pkce`;
    const value = this.#pkce ? await this.#pkce.consume(() => this.#nativeValue(key)) : await this.storage.getItem(key);
    await this.storage.removeItem(key);
    return value;
  }
  current(): Promise<Session | null> { return this.#locked(() => this.#read()); }
  #marginFor(session: Session): number {
    // A short-lived token or a large configured margin must not make every
    // request (or every background tick) rotate a freshly issued token.
    return Math.min(this.#margin, session.expires_in / 2);
  }
  async #reload(): Promise<void> {
    await this.#locked(async () => {
      if (this.#dirty && !this.#native) return;
      const before = this.#session;
      const after = await this.#read(true);
      this.#schedule(this.#dirty ? null : after);
      if (after === null) {
        if (before) this.#emit('signed_out', null);
        return;
      }
      this.#emit(before ? 'refreshed' : 'signed_in', after);
    });
  }
  async #write(session: Session | null, event: AuthEvent, completingRefresh = false): Promise<void> {
    const encoded = encodeJson(session);
    this.#revision++;
    this.#session = session;
    this.#dirty = true;
    this.#schedule(null);
    try {
      await this.#persist(encoded, completingRefresh);
      this.#schedule(session);
    }
    catch (error) {
      if (error instanceof BrowserSessionConflictError) {
        // The response lost ownership: never announce its discarded session.
        this.#session = null;
        this.#dirty = false;
        try { await this.#read(true); }
        catch { /* Keep local state cleared if the authoritative read fails. */ }
        event = this.#session ? 'signed_in' : 'signed_out';
        this.#schedule(this.#session);
      }
      throw error;
    }
    finally {
      this.#emit(event, this.#session ?? null);
    }
  }
  async #persist(encoded?: string, completingRefresh = false): Promise<void> {
    const session = this.#session;
    await this.#native?.write(session ? encoded ?? encodeJson(session) : null, completingRefresh);
    await (session ? this.storage.setItem(this.key, encoded ?? encodeJson(session)) : this.storage.removeItem(this.key));
    this.#dirty = false;
    this.#broadcast?.notify();
  }
  set(session: Session): Promise<void> {
    if (!isSession(session)) throw new NelcotaUsageError('Not a Nelcota session');
    return this.#locked(async () => {
      if (this.#native) await this.#read(true, true);
      await this.#write(session, 'signed_in');
    });
  }
  async authenticate<T extends Authentication>(request: () => Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>> {
    if (signal?.aborted) return fail(clientError('aborted', 'The request was aborted'));
    let entry: typeof request | undefined = request;
    const result = await abortable(this.#locked(async () => {
      const task = entry;
      entry = undefined;
      if (!task) return fail(clientError('aborted', 'The request was aborted'));
      // Capture the receipt before HTTP: failed publication must retain an
      // accepted sign-in until that exact receipt is superseded.
      if (this.#native) await this.#read(true, true);
      const result = await task();
      if (result.error) return result;
      const data: Authentication = result.data;
      const session = isSession(data) ? data : data.session;
      if (session) await this.#write(session, 'signed_in');
      return result;
    }), signal, () => { entry = undefined; });
    return result.data ?? result;
  }
  async get(options: AuthRequestOptions = {}): Promise<Result<Session | null>> {
    if (options.signal?.aborted) return fail(clientError('aborted', 'The request was aborted'));
    const current = await abortable(this.current(), options.signal);
    if (current.error) return fail(current.error);
    const session = current.data;
    if (!session || secondsLeft(session) > this.#marginFor(session)) return ok(session);
    const refreshed = await this.refresh(options, session);
    if (refreshed.error?.code === 'invalid_grant' || refreshed.error?.code === 'session_missing') return ok(null);
    return refreshed;
  }
  async accessToken(): Promise<string | null> {
    const result = await this.get();
    return result.data?.access_token ?? this.#session?.access_token ?? null;
  }
  #refreshSnapshot(): Session | null {
    if (!this.#native || this.#dirty) return this.#session ?? null;
    // This is only a comparison hint. Read before waiting on the Web Lock:
    // current() could wait for another rotation and observe its replacement.
    // The locked journal read below remains the authority for every mutation.
    try { return parseSession(this.#nativeValue(this.key)) ?? this.#session ?? null; }
    catch { return this.#session ?? null; }
  }
  refresh(options: AuthRequestOptions = {}, snapshot?: Session): Promise<Result<Session>> {
    if (options.signal?.aborted) return Promise.resolve(fail(clientError('aborted', 'The request was aborted')));
    this.#refreshing ??= (async () => {
      // A broadcast can reload a replacement after get() observed expiry.
      // Compare with that original session instead of rotating its replacement.
      const known = snapshot ?? this.#refreshSnapshot() ?? await this.current();
      if (!known) return fail(clientError('session_missing', 'Not signed in'));
      return this.#locked(async () => {
        const current = await this.#read(true);
        if (!current) return fail(clientError('session_missing', 'Not signed in'));
        if (current.refresh_token !== known.refresh_token && secondsLeft(current) > this.#marginFor(current)) return ok(current);
        await this.#native?.reserve(current);
        // Once started, rotation owns its lifetime. A cancelled waiter must
        // not discard the replacement for a token already spent by the server.
        const result = await this.rotate(current.refresh_token, options.timeout === undefined ? {} : { timeout: options.timeout });
        if (result.error) {
          if (result.error.code === 'invalid_grant') await this.#write(null, 'signed_out', true);
          return result;
        }
        await this.#write(result.data, 'refreshed', true);
        return result;
      });
    })().finally(() => { this.#refreshing = null; });
    return abortable(this.#refreshing, options.signal).then(result => result.data ?? result);
  }
  rememberUser(snapshot: Session): (user: User) => Promise<void> {
    const revision = snapshot === this.#session && `${this.#revision}/${this.#native?.revision}`;
    return user => this.#locked(async () => {
      const current = await this.#read(true);
      if (!current || revision !== `${this.#revision}/${this.#native?.revision}`
          || encodeJson(current) !== encodeJson(snapshot)
          || encodeJson(current.user) === encodeJson(user)) return;
      await this.#write({ ...current, user }, 'user_updated');
    });
  }
  signOut(request: (session: Session) => Promise<Result<null>>): Promise<Result<null>> {
    return this.#locked(async () => {
      try {
        const session = await this.#read(true, true);
        if (session) {
          const result = await request(session);
          await this.#write(null, 'signed_out');
          return result;
        }
        if (this.#dirty) await this.#persist();
        this.#schedule(null);
        return ok(null);
      }
      finally {
        // Match exchangeCode's lifecycle -> PKCE lock order. Consume commits a
        // null receipt before removing the potentially stale native mirror.
        await withLock(`${this.key}.pkce`, () => this.consumeVerifier());
      }
    });
  }
  #schedule(session: Session | null, delayMs?: number): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || !this.#autoRefresh || !session) return;
    const remaining = secondsLeft(session);
    const wait = Math.max(0, (remaining - this.#marginFor(session)) * 1000);
    const jitter = Math.random() * Math.min(5000, wait / 2);
    const due = delayMs ?? Math.max(remaining <= 0 ? RETRY_REFRESH_MS : 1000, wait - jitter);
    this.#timer = setTimeout(() => {
      this.#background(this.get().then(async ({ data, error }) => {
        if (error && error.code !== 'invalid_grant' && error.code !== 'session_missing') {
          this.#schedule(await this.current(), RETRY_REFRESH_MS);
          return;
        }
        if (!this.#dirty) this.#schedule(data);
      }));
    }, Math.min(due, 2 ** 31 - 1));
    (this.#timer as { unref?: () => void }).unref?.();
  }
  #background(operation: Promise<unknown>, pause = true): void {
    void operation.catch(async error => {
      if (this.#disposed) return;
      if (pause) this.#schedule(null);
      // Listener failures do not pause refresh. Error handlers are isolated.
      try { await this.#onBackgroundError?.(error); }
      catch { /* Includes asynchronous handler failures. */ }
    });
  }
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#broadcast?.close();
    this.#listeners.clear();
  }
}
