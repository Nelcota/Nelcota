/**
 * The session's lifecycle: sign-in, refresh and sign-out transitions under one
 * lock, and the events they announce. Persistence lives in `SessionStore`,
 * timers in `RefreshScheduler` and cross-tab primitives in `coordination`.
 */
import { isSession, secondsLeft, type Session, type User } from './session.js';
import { BrowserSessionConflictError } from './browser-state.js';
import { Broadcast, withLock, sessionLock } from './coordination.js';
import { SessionStore, storageKey } from './store.js';
import { QUICK_RETRY_REFRESH_MS, RefreshScheduler, RETRY_REFRESH_MS } from './scheduler.js';
import { NelcotaUsageError, clientError, fail, ok, type Result } from '../core/errors.js';
import { abortable } from '../core/cancellation.js';
import { isBrowser } from '../core/jwt.js';
import { encodeJson } from '../core/json.js';
import type { TokenSource } from '../core/http.js';

import type { AuthEvent, AuthListener, AuthOptions, AuthRequestOptions } from './types.js';
export type { AuthEvent, AuthListener, AuthOptions, AuthRequestOptions } from './types.js';

// Sign-out renews only an expired token, allowing this much clock skew.
const SIGN_OUT_SKEW = 5;
type Authentication = Session | { user: User; session: Session | null };

export class SessionManager {
  readonly #store: SessionStore;
  readonly #lockName: string | symbol;
  readonly #pkceLockName: string | symbol;
  readonly #margin: number;
  readonly #scheduler: RefreshScheduler;
  readonly #listeners = new Set<AuthListener>();
  readonly #broadcast: Broadcast | undefined;
  readonly #onBackgroundError: AuthOptions['onBackgroundError'];
  #refreshing: Promise<Result<Session>> | null = null;

  constructor(url: URL, options: AuthOptions, private rotate: (token: string, options: AuthRequestOptions) => Promise<Result<Session>>, accessToken?: TokenSource) {
    const margin = options.refreshMargin ?? 60;
    if (!Number.isFinite(margin) || margin < 0) throw new NelcotaUsageError('refreshMargin must be a finite non-negative number');
    this.#margin = margin;
    const browser = isBrowser();
    const store = this.#store = new SessionStore(options.storageKey ?? storageKey(url), options.storage);
    this.#lockName = sessionLock(store.storage, store.key, browser, !!options.storage);
    this.#pkceLockName = sessionLock(store.storage, store.key, browser, !!options.storage, 'pkce');
    this.#scheduler = new RefreshScheduler(!accessToken && (options.autoRefresh ?? browser), session => this.#marginFor(session), () => this.#tick());
    this.#onBackgroundError = options.onBackgroundError;
    if (browser) {
      let privateStorage = false;
      try { privateStorage = store.storage === globalThis.sessionStorage; } catch { /* Sandboxed storage. */ }
      if (!privateStorage) this.#broadcast = new Broadcast(`${store.key}.channel`, (event, revision) => this.#background(this.#reload(event, revision)));
    }
    if (this.#scheduler.enabled) this.#background(this.current().then(session => this.#scheduler.schedule(session)));
  }

  withVerifier<T>(task: () => Promise<T>): Promise<T> { return withLock(this.#pkceLockName, task); }
  setVerifier(value: string): Promise<void> { return this.#store.setVerifier(value); }
  consumeVerifier(): Promise<string | null> { return this.#store.consumeVerifier(); }

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
  current(): Promise<Session | null> { return this.#locked(() => this.#store.read()); }
  #marginFor(session: Session): number {
    // A short-lived token or a large configured margin must not make every
    // request (or every background tick) rotate a freshly issued token.
    return Math.min(this.#margin, session.expires_in / 2);
  }
  async #reload(event?: AuthEvent, revision?: string): Promise<void> {
    const store = this.#store;
    await this.#locked(async () => {
      if (store.dirty && !store.journaled) return;
      const before = store.session;
      const after = await store.read(true);
      if (revision !== store.journalRevision) event = undefined;
      this.#scheduler.schedule(store.dirty ? null : after);
      if (before !== undefined && encodeJson(before) === encodeJson(after)) return;
      if (after === null) {
        if (before || event === 'signed_out') this.#emit('signed_out', null);
        return;
      }
      const inferred = !before || before.user.id !== after.user.id ? 'signed_in' : before.refresh_token !== after.refresh_token ? 'refreshed' : 'user_updated';
      this.#emit(before && before.user.id !== after.user.id ? 'signed_in' : event ?? inferred, after);
    });
  }
  async #write(session: Session | null, event: AuthEvent, completingRefresh = false): Promise<void> {
    const store = this.#store;
    const encoded = encodeJson(session);
    store.adopt(session);
    this.#scheduler.schedule(null);
    try {
      await this.#persist(encoded, completingRefresh, event);
      this.#scheduler.schedule(session);
    }
    catch (error) {
      if (error instanceof BrowserSessionConflictError) {
        // The response lost ownership: never announce its discarded session.
        store.discard();
        try { await store.read(true); }
        catch { /* Keep local state cleared if the authoritative read fails. */ }
        event = store.session ? 'signed_in' : 'signed_out';
        this.#scheduler.schedule(store.session ?? null);
      }
      throw error;
    }
    finally {
      this.#emit(event, store.session ?? null);
    }
  }
  async #persist(encoded?: string, completingRefresh = false, event?: AuthEvent): Promise<void> {
    await this.#store.persist(encoded, completingRefresh);
    this.#broadcast?.notify(event, this.#store.journalRevision);
  }
  set(session: Session): Promise<void> {
    if (!isSession(session)) throw new NelcotaUsageError('Not a Nelcota session');
    return this.#locked(async () => {
      if (this.#store.journaled) await this.#store.read(true, true);
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
      if (this.#store.journaled) await this.#store.read(true, true);
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
    if (result.error) throw result.error;
    return result.data?.access_token ?? null;
  }
  refresh(options: AuthRequestOptions = {}, snapshot?: Session): Promise<Result<Session>> {
    if (options.signal?.aborted) return Promise.resolve(fail(clientError('aborted', 'The request was aborted')));
    this.#refreshing ??= (async () => {
      // A broadcast can reload a replacement after get() observed expiry.
      // Compare with that original session instead of rotating its replacement.
      const known = snapshot ?? this.#store.hint() ?? await this.current();
      if (!known) return fail(clientError('session_missing', 'Not signed in'));
      return this.#locked(async () => {
        const current = await this.#store.read(true);
        if (!current) return fail(clientError('session_missing', 'Not signed in'));
        if (current.refresh_token !== known.refresh_token && secondsLeft(current) > this.#marginFor(current)) return ok(current);
        return this.#rotate(current, options);
      });
    })().finally(() => { this.#refreshing = null; });
    return abortable(this.#refreshing, options.signal).then(result => result.data ?? result);
  }
  async #rotate(current: Session, options: AuthRequestOptions, publish = true): Promise<Result<Session>> {
    await this.#store.reserve(current);
    // Accepted rotation owns publication independently of a cancelled waiter.
    const result = await this.rotate(current.refresh_token, options.timeout === undefined ? {} : { timeout: options.timeout });
    if (result.error) {
      if (publish && result.error.code === 'invalid_grant') await this.#write(null, 'signed_out', true);
      // Every other 4xx is returned before the rotation commits (rate limit,
      // malformed request), so the stored token is still valid. A 5xx can
      // follow an ambiguous commit and a lost response has no answer at all:
      // preserve their reservation.
      const { code, status } = result.error;
      if (code !== 'invalid_grant' && status >= 400 && status < 500) await this.#store.release(current);
      return result;
    }
    if (publish) await this.#write(result.data, 'refreshed', true);
    return result;
  }
  rememberUser(snapshot: Session): (user: User) => Promise<void> {
    const store = this.#store;
    const encoded = encodeJson(snapshot);
    const revision = store.session !== null && store.session !== undefined && encodeJson(store.session) === encoded && store.revision;
    return user => this.#locked(async () => {
      const current = await store.read(true);
      if (!current || revision !== store.revision
          || encodeJson(current) !== encoded
          || encodeJson(current.user) === encodeJson(user)) return;
      await this.#write({ ...current, user }, 'user_updated');
    });
  }
  signOut(request: (session: Session) => Promise<Result<null>>, options: AuthRequestOptions = {}): Promise<Result<null>> {
    return this.#locked(async () => {
      try {
        const session = await this.#store.read(true, true);
        // The only transition: sign-out never publishes or announces a renewal.
        if (session) try { return await this.#revoke(session, request, options); } finally { await this.#write(null, 'signed_out'); }
        if (this.#store.dirty) await this.#persist();
        this.#scheduler.schedule(null);
        return ok(null);
      }
      finally {
        // Match exchangeCode's lifecycle -> PKCE lock order. Consume commits a
        // null receipt before removing the potentially stale native mirror.
        await this.withVerifier(() => this.consumeVerifier());
      }
    });
  }
  async #revoke(session: Session, request: (session: Session) => Promise<Result<null>>, options: AuthRequestOptions): Promise<Result<null>> {
    if (this.#store.pending || options.signal?.aborted || secondsLeft(session) > SIGN_OUT_SKEW) return request(session);
    // Renew an expired token only to revoke its replacement, which stays in memory.
    let renewed: Result<Session> | undefined, failure: unknown;
    try { renewed = await this.#rotate(session, options, false); } catch (error) { failure = error; }
    if (renewed && !renewed.error) return request(renewed.data);
    if (secondsLeft(session) > 0) return request(session);
    if (renewed) return fail(renewed.error);
    throw failure;
  }
  #retries = 0;
  #tick(): void {
    this.#background(this.get().then(async ({ data, error }) => {
      if (error && error.code !== 'invalid_grant' && error.code !== 'session_missing') {
        this.#scheduler.schedule(await this.current(), this.#retries++ === 0 ? QUICK_RETRY_REFRESH_MS : RETRY_REFRESH_MS);
        return;
      }
      this.#retries = 0;
      if (!this.#store.dirty) this.#scheduler.schedule(data);
    }));
  }
  #background(operation: Promise<unknown>, pause = true): void {
    void operation.catch(async error => {
      if (this.#scheduler.disposed) return;
      if (pause) this.#scheduler.schedule(null);
      // Listener failures do not pause refresh. Error handlers are isolated.
      try { await this.#onBackgroundError?.(error); }
      catch { /* Includes asynchronous handler failures. */ }
    });
  }
  dispose(): void {
    this.#scheduler.dispose();
    this.#broadcast?.close();
    this.#listeners.clear();
  }
}
