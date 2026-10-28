import { equalState, sha256 } from './crypto.js';
import { createClient, type AuthRequestOptions, NelcotaError, type Credentials, type DefaultSchemaName, type FetchLike, type NelcotaClient, type OAuthProvider, type Result, type Session, type SessionStorage, type SignUpInput, type User, type UserUpdate } from '@nelcota/client';
import { SessionError } from './errors.js';
import { requireMutation, safeReturnTo, trustedUrl } from './policy.js';
import { newSessionId, sessionKey, SessionSealer, type SessionState } from './seal.js';
import type { SessionLease, SessionStore, StoredSession } from './store.js';

export interface CookieReader { get(name: string): { value: string } | undefined }
export interface CookieWriter extends CookieReader {
  set(name: string, value: string, options: { path: '/'; httpOnly: true; secure: boolean; sameSite: 'lax'; maxAge: number }): void;
}
export interface SessionOptions {
  url: string;
  appOrigin: string;
  /** Path the app is mounted under (Next `basePath`, SvelteKit `paths.base`), e.g. '/app'; prefixes the OAuth callback. Default ''. */
  basePath?: string;
  keys: readonly string[];
  store: SessionStore;
  allowInsecureDevelopment?: boolean;
  cookieName?: string;
  sessionTtlSeconds?: number;
  timeout?: number;
  fetch?: FetchLike;
  /** Absolute origins that storage object downloads may be redirected to,
   * e.g. a presigned S3 endpoint. HTTPS only (loopback HTTP with
   * `allowInsecureDevelopment`). Unset: storage redirects are refused. */
  storageRedirectOrigins?: readonly string[];
}
export type DataClient<Database> = Pick<NelcotaClient<Database, DefaultSchemaName<Database>>, 'from' | 'rpc' | 'storage' | 'url'>;
export interface VerifiedContext<Database> {
  client: DataClient<Database>;
  hasSession: boolean;
  /** A cookie was presented without usable state (missing, expired or unreadable). */
  staleCookie: boolean;
  /** The presented cookie belongs to an identity a later sign-in/out in this browser replaced. */
  superseded: boolean;
  getUser(options?: AuthRequestOptions): Promise<Result<User>>;
}
export type MutationOptions = Pick<AuthRequestOptions, 'timeout'>;
function mutationOptions(options?: MutationOptions): MutationOptions {
  if (options?.timeout === undefined) return {};
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 100 || options.timeout > 30000) throw new SessionError('configuration', 'Mutation timeout must be between 100 and 30000 ms');
  return { timeout: options.timeout };
}
export interface AuthOperations {
  getUser(): Promise<Result<User>>;
  signInWithPassword(input: Credentials, options?: MutationOptions): Promise<Result<User>>;
  signUp(input: SignUpInput, options?: MutationOptions): Promise<Result<{ user: User; confirmationRequired: boolean }>>;
  signOut(options?: MutationOptions): Promise<Result<null>>;
  refresh(options?: MutationOptions): Promise<Result<{ user: User; expiresAt: number } | null>>;
  updateUser(input: UserUpdate, options?: MutationOptions): Promise<Result<User>>;
  requestPasswordReset(email: string, options?: MutationOptions): Promise<Result<null>>;
  sendMagicLink(email: string, options?: MutationOptions): Promise<Result<null>>;
  resendConfirmation(email: string, options?: MutationOptions): Promise<Result<null>>;
  startOAuth(input: { provider: OAuthProvider; returnTo?: string }): Promise<Result<{ url: string }>>;
  exchangeCode(code: string, options?: MutationOptions): Promise<Result<{ user: User; returnTo: string }>>;
  verifyEmailLink(input: { type: 'signup' | 'magiclink'; token: string }, options?: MutationOptions): Promise<Result<User>>;
  resetPassword(input: { token: string; password: string }, options?: MutationOptions): Promise<Result<User>>;
}
export interface WritableContext<Database> { client: DataClient<Database>; auth: AuthOperations }

function accessToken(state: SessionState | null): string | null {
  if (!state?.session) return null;
  const value: unknown = JSON.parse(state.session);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('invalid_session', 'Invalid stored session');
  const token = (value as Record<string, unknown>)['access_token'];
  if (typeof token !== 'string' || token.length === 0 || token.length > 16384) throw new SessionError('invalid_session', 'Invalid stored access token');
  return token;
}

/** Storage-redirect bound; each hop is re-validated against the allow-list. */
const maxStorageHops = 3;
/** Only these request headers survive a cross-origin storage hop; credentials never do. */
const hopHeaders = ['accept', 'range', 'if-none-match', 'if-match', 'if-modified-since', 'if-unmodified-since', 'if-range'];
function refusedRedirect(code: 'storage_redirect_refused' | 'storage_redirect_limit', message: string): NelcotaError {
  return new NelcotaError({ status: 0, code, message });
}

/** Rows that share one browser cookie history share a lineage record. */
function lineageOf(key: string): Promise<string> { return sha256(`nelcota-next/lineage\0${key}`); }
interface Loaded {
  state: SessionState | null;
  /** A row existed at the key, readable or not. */
  row: boolean;
  lineage: string | null;
  /** Retired by a later identity of the same lineage (tombstone or dead session row). */
  superseded: boolean;
  tombstone: boolean;
}
interface LineageHead { current: string; generation: number }

/** Configuration/store/key capabilities can be shared; each context is request-owned. */
export class Integration<Database> {
  readonly #api: URL;
  readonly #origin: string;
  readonly #basePath: string;
  readonly #name: string;
  readonly #secure: boolean;
  readonly #ttl: number;
  readonly #namespace: string;
  readonly #options: Omit<SessionOptions, 'keys'>;
  readonly #sealer: SessionSealer;
  readonly #redirects: ReadonlySet<string>;
  private constructor(options: SessionOptions, sealer: SessionSealer, scope: string) {
    const { keys: _keys, ...settings } = options;
    this.#options = settings; this.#sealer = sealer;
    const development = options.allowInsecureDevelopment === true;
    this.#api = trustedUrl(options.url, development);
    const app = trustedUrl(options.appOrigin, development, true);
    if (development && !['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) throw new SessionError('configuration', 'Insecure development requires a loopback application origin');
    this.#origin = app.origin; this.#secure = app.protocol === 'https:';
    this.#basePath = options.basePath ?? '';
    if (this.#basePath !== '' && (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/.test(this.#basePath))) throw new SessionError('configuration', 'basePath must be empty or a canonical path such as /app');
    this.#namespace = `${this.#origin}\0${this.#api.href}`;
    this.#name = options.cookieName ?? `${this.#secure ? '__Host-nelcota' : 'nelcota-dev'}-${scope}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.#name) || (this.#secure && !this.#name.startsWith('__Host-')) || (!this.#secure && this.#name.startsWith('__Host-'))) throw new SessionError('configuration', 'Invalid host-only session cookie name');
    this.#ttl = options.sessionTtlSeconds ?? 604800;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 300 || this.#ttl > 2592000) throw new SessionError('configuration', 'Session TTL must be between five minutes and thirty days');
    if (!Number.isSafeInteger(options.timeout ?? 30000) || (options.timeout ?? 30000) < 100 || (options.timeout ?? 30000) > 30000) throw new SessionError('configuration', 'Request timeout must be between 100 and 30000 ms');
    if (options.store.durability !== 'shared' && !development) throw new SessionError('configuration', 'Production requires an authoritative shared session store');
    const redirects = options.storageRedirectOrigins ?? [];
    if (!Array.isArray(redirects) || redirects.length > 16) throw new SessionError('configuration', 'storageRedirectOrigins must be an array of at most sixteen origins');
    this.#redirects = new Set(redirects.map(origin => {
      if (typeof origin !== 'string') throw new SessionError('configuration', 'storageRedirectOrigins must contain origin strings');
      return trustedUrl(origin, development, true).origin;
    }));
  }
  static async create<Database>(options: SessionOptions): Promise<Integration<Database>> {
    // Session keys and tokens must never reach a browser bundle.
    if (typeof (globalThis as { document?: unknown }).document !== 'undefined') throw new SessionError('configuration', '@nelcota/ssr sessions run only on the server');
    const development = options.allowInsecureDevelopment === true;
    const namespace = `${trustedUrl(options.appOrigin, development, true).origin}\0${trustedUrl(options.url, development).href}`;
    const scope = (await sha256(namespace)).slice(0, 12);
    return new Integration<Database>({ ...options }, await SessionSealer.create(options.keys), scope);
  }
  get origin(): string { return this.#origin; }
  get basePath(): string { return this.#basePath; }
  #binding(key: string): string { return `nelcota-next/v1\0${this.#origin}\0${this.#api.href}\0${key}`; }
  #lineageBinding(lineage: string): string { return `nelcota-next/lineage/v1\0${this.#origin}\0${this.#api.href}\0${lineage}`; }
  /** Unreadable rows (lost keys, tampering, mismatched expiry) count as signed out.
   * A session-bearing row is live only while its lineage head names its key and
   * generation; otherwise a later sign-in/out in the same browser replaced it.
   */
  async #load(key: string, lease?: SessionLease): Promise<Loaded> {
    const row = await this.#readStored(() => lease ? lease.load() : this.#options.store.read(key));
    const unusable: Loaded = { state: null, row: row !== null, lineage: null, superseded: false, tombstone: false };
    if (!row) return unusable;
    let state: SessionState;
    try { state = await this.#sealer.open(row.sealed, this.#binding(key)); }
    catch (cause) { if (!(cause instanceof SessionError)) throw cause; return unusable; }
    // Expired after the store check, unreadable or mismatched: all are no session.
    if (row.expiresAt !== state.expiresAt) return unusable;
    const lineage = state.lineage ?? null;
    if (state.superseded) return { state: null, row: true, lineage, superseded: true, tombstone: true };
    if (state.session !== null && lineage !== null && state.generation !== undefined) {
      const head = await this.#head(lineage, undefined, lease);
      if (head?.current !== key || head.generation !== state.generation) return { state: null, row: true, lineage, superseded: true, tombstone: false };
    }
    return { state, row: true, lineage, superseded: false, tombstone: false };
  }
  /** A missing or unreadable head fails closed: no generation of that lineage is live. */
  async #head(lineage: string, lease?: SessionLease, parent?: SessionLease): Promise<LineageHead | null> {
    const row = await this.#readStored(() => lease ? lease.load() : parent?.read ? parent.read(lineage) : this.#options.store.read(lineage));
    if (!row) return null;
    let value: Record<string, unknown>;
    try { value = await this.#sealer.openRecord(row.sealed, this.#lineageBinding(lineage)); }
    catch (cause) { if (!(cause instanceof SessionError)) throw cause; return null; }
    const current = value['current'], generation = value['generation'];
    if (value['kind'] !== 'lineage' || typeof current !== 'string' || !/^[a-f0-9]{64}$/.test(current) || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return null;
    return { current, generation };
  }
  async #readStored(read: () => Promise<StoredSession | null>): Promise<StoredSession | null> {
    try { return await read(); }
    catch (cause) {
      if (cause instanceof SessionError) throw cause;
      throw new SessionError('session_store', 'Session storage is unavailable', cause);
    }
  }
  /** Credential-free marker that keeps a retired key linked to its lineage. */
  async #tombstone(key: string, lineage: string): Promise<StoredSession> {
    const expiresAt = Date.now() + this.#ttl * 1000;
    return { sealed: await this.#sealer.seal({ schema: 1, session: null, pkce: null, oauthState: null, returnTo: '/', expiresAt, lineage, superseded: true }, this.#binding(key)), expiresAt };
  }
  /** Replaces a superseded session row (an orphan) with a tombstone under its own lock. */
  async #retire(key: string): Promise<void> {
    await this.#options.store.exclusive(key, async lease => {
      const loaded = await this.#load(key, lease);
      if (!loaded.superseded || loaded.tombstone || loaded.lineage === null) return;
      await lease.save(await this.#tombstone(key, loaded.lineage));
    });
  }
  /** Gives a cookie-less browser a credential-free ID before it signs in, so that
   * concurrent first sign-ins from its tabs share one lineage. No row is stored;
   * a write never adopts it and moves to a fresh ID. Returns whether it was set.
   */
  bootstrap(request: CookieReader, response: CookieWriter): boolean {
    if (request.get(this.#name)?.value) return false;
    try { response.set(this.#name, newSessionId(), { httpOnly: true, secure: this.#secure, sameSite: 'lax', path: '/', maxAge: this.#ttl }); }
    catch (cause) { throw new SessionError('session_store', 'Session cookie publication failed', cause); }
    return true;
  }
  /** Clears this integration's cookie, e.g. on a proxy redirect for a stale session. */
  expireCookie(cookies: CookieWriter): void {
    try { cookies.set(this.#name, '', { httpOnly: true, secure: this.#secure, sameSite: 'lax', path: '/', maxAge: 0 }); }
    catch (cause) { throw new SessionError('session_store', 'Session cookie publication failed', cause); }
  }
  /** GET/HEAD object downloads are the only requests that may follow a redirect. */
  #storageObject(url: URL, method: string): boolean {
    const prefix = `${this.#api.pathname.replace(/\/$/, '')}/storage/v1/object/`;
    return (method === 'GET' || method === 'HEAD') && url.pathname.startsWith(prefix);
  }
  /** Follows at most `maxStorageHops` redirects, each to an allow-listed origin.
   * Credentials are dropped on the first hop away from the API origin and never return.
   */
  async #followStorage(send: FetchLike, url: URL, init: RequestInit): Promise<Response> {
    let target = url, headers = new Headers(init.headers), credentialed = true;
    for (let hop = 0; ; hop++) {
      const response = await send(target.href, { ...init, headers, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (this.#redirects.size === 0) throw refusedRedirect('storage_redirect_refused', 'Storage redirects require an explicit storageRedirectOrigins policy');
      if (hop >= maxStorageHops) throw refusedRedirect('storage_redirect_limit', 'Too many storage redirects');
      let next: URL;
      try { next = new URL(location ?? '', target); }
      catch { throw refusedRedirect('storage_redirect_refused', 'Invalid storage redirect location'); }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(next.hostname);
      const transport = next.protocol === 'https:' || (next.protocol === 'http:' && loopback && this.#options.allowInsecureDevelopment === true);
      if (!location || !transport || next.username || next.password || !this.#redirects.has(next.origin)) throw refusedRedirect('storage_redirect_refused', 'Storage redirect destination is not allowed');
      if (next.origin !== this.#api.origin) credentialed = false;
      if (!credentialed) headers = new Headers(hopHeaders.flatMap(name => { const value = headers.get(name); return value === null ? [] : [[name, value] as [string, string]]; }));
      target = next;
    }
  }
  #client(token: () => string | null, alive: () => boolean, readOnly: boolean, lifetime?: AbortSignal): NelcotaClient<Database> {
    const send = this.#options.fetch ?? globalThis.fetch.bind(globalThis);
    return createClient<Database>(this.#api.href, {
      accessToken: () => { if (!alive()) throw new SessionError('closed_context', 'The request context has ended'); return token(); }, timeout: this.#options.timeout ?? 30000, retries: 0,
      auth: { autoRefresh: false },
      fetch: async (input, init) => {
        if (!alive()) throw new SessionError('closed_context', 'The request context has ended');
        if (readOnly && !['GET', 'HEAD'].includes(init?.method ?? 'GET')) throw new NelcotaError({ status: 0, code: 'read_only', message: 'Server Components cannot mutate data or session state' });
        const url = new URL(String(input));
        if (url.origin !== this.#api.origin) throw new SessionError('configuration', 'Request escaped the configured API origin');
        const ownership = new AbortController();
        const lost = (): void => ownership.abort();
        lifetime?.addEventListener('abort', lost, { once: true });
        if (lifetime?.aborted) lost();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new DOMException('Header deadline exceeded', 'TimeoutError')), this.#options.timeout ?? 30000);
        const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), ownership.signal, deadline.signal]);
        try {
          // Once headers arrive, the response/body consumer owns the accepted
          // transfer. Closing a session lease must not truncate a returned stream.
          if (this.#storageObject(url, init?.method ?? 'GET')) return await this.#followStorage(send, url, { ...init, signal, cache: 'no-store' });
          return await send(input, { ...init, signal, cache: 'no-store', redirect: 'error' });
        } finally { clearTimeout(timer); lifetime?.removeEventListener('abort', lost); }
      },
    });
  }
  #data(client: NelcotaClient<Database>): DataClient<Database> {
    return { from: client.from.bind(client), rpc: client.rpc.bind(client), storage: client.storage, url: client.url };
  }
  /**
   * `clearable` (for the proxy) tells whether a stale presented cookie may be deleted: like
   * the write path, a row-less (bootstrap or pre-login) or superseded ID is kept, because the
   * browser may already hold its replacement from a sign-in response still in flight.
   */
  async read<T>(cookies: CookieReader, work: (context: VerifiedContext<Database>, details: { clearable: boolean }) => Promise<T>): Promise<T> {
    const id = cookies.get(this.#name)?.value ?? '', key = await sessionKey(id, this.#namespace);
    const loaded = key ? await this.#load(key) : null, state = loaded?.state ?? null;
    let alive = true;
    const client = this.#client(() => accessToken(state), () => alive, true);
    try { return await work({ client: this.#data(client), hasSession: state?.session !== null && state?.session !== undefined, staleCookie: id !== '' && state === null, superseded: loaded?.superseded === true, getUser: options => client.auth.getUser(options) }, { clearable: id !== '' && state === null && (loaded === null || (loaded.row && !loaded.superseded)) }); }
    finally { alive = false; client.dispose(); }
  }
  /** Explicit same-origin local reset, usable even when old keys/state are unavailable. */
  async forget(cookies: CookieWriter, request: Request): Promise<void> {
    requireMutation(request.headers, request.method, this.#origin);
    const key = await sessionKey(cookies.get(this.#name)?.value ?? '', this.#namespace);
    if (key) await this.#options.store.exclusive(key, lease => lease.remove());
    this.expireCookie(cookies);
  }
  async write<T>(cookies: CookieWriter, request: Request, work: (context: WritableContext<Database>) => Promise<T>, callback = false): Promise<T> {
    // Callback GET only permits the PKCE exchange method, never general mutations.
    // Match the path only: request.url's host comes from an untrusted Host header.
    // The host-only cookie and one-use state/PKCE bind the callback to its browser.
    const callbackRequest = callback && request.method === 'GET' && new URL(request.url).pathname === `${this.#basePath}/auth/callback`;
    if (callback && !callbackRequest) throw new SessionError('csrf', 'Use the configured GET OAuth callback');
    if (!callbackRequest) requireMutation(request.headers, request.method, this.#origin);
    const existingId = cookies.get(this.#name)?.value ?? '';
    const presented = (await sessionKey(existingId, this.#namespace)) !== null;
    let id = presented ? existingId : newSessionId();
    const initialKey = await sessionKey(id, this.#namespace);
    if (!initialKey) throw new SessionError('invalid_session', 'Invalid generated session id');
    // Session rows a later lineage head replaced; tombstoned after this lease ends,
    // so this request never waits for another key while holding its own.
    const retired = new Set<string>();
    try { return await this.#options.store.exclusive(initialKey, async lease => {
      let key = initialKey;
      const loaded = await this.#load(key, lease);
      let state = loaded.state;
      // Every ID this browser cookie held shares the lineage of the first one: inherited
      // from stored state/tombstones, or seeded by a presented (bootstrap) or fresh ID.
      const lineage = loaded.lineage ?? await lineageOf(initialKey);
      // The lineage generation this response publishes; null for pre-lineage or pending-only state.
      let generation = state?.session !== null && state?.session !== undefined ? state.generation ?? null : null;
      let alive = true, accepting = true, failed = false, cookieNeeded = false;
      let identityMutation = false, published = id === existingId;
      // Malformed cookies and unreadable rows are cleared; a row-less ID may be a bootstrap
      // and a superseded one may already be replaced in the browser, so neither is cleared.
      const clearPresented = existingId !== '' && (!presented || (loaded.row && !loaded.superseded));
      let queued = 0, tail: Promise<void> = Promise.resolve();
      const storageKey = `nelcota-next.${initialKey}.session`;
      const ensure = (): void => { if (!alive || failed || lease.signal.aborted) throw new SessionError('closed_context', 'The session context is no longer writable'); };
      // Never adopt a browser-chosen or pre-login ID: move to a fresh unpublished one.
      // `retain` leaves a tombstone so delayed requests with the old ID find the lineage.
      const rotate = async (retain: boolean): Promise<void> => {
        const nextId = newSessionId(), nextKey = await sessionKey(nextId, this.#namespace);
        if (!nextKey) throw new SessionError('invalid_session', 'Invalid generated session id');
        try { await lease.rotate(nextKey, retain ? await this.#tombstone(key, lineage) : undefined); id = nextId; key = nextKey; published = false; }
        catch (cause) { failed = true; throw new SessionError('session_store', 'Session publication failed', cause); }
      };
      // Unknown, expired or unreadable rows are removed and proceed signed out under a fresh ID.
      // Superseded rows become (or stay) tombstones without credentials.
      if (!state && published) await rotate(loaded.superseded);
      // Makes this request's key the lineage head; every earlier generation stops being live.
      const register = async (): Promise<number> => {
        ensure();
        try {
          const exclusive = lease.exclusive?.bind(lease) ?? this.#options.store.exclusive.bind(this.#options.store);
          return await exclusive(lineage, async owner => {
            const head = await this.#head(lineage, owner);
            const next = (head?.generation ?? 0) + 1, expiresAt = Date.now() + this.#ttl * 1000;
            await owner.save({ sealed: await this.#sealer.seal({ kind: 'lineage', current: key, generation: next }, this.#lineageBinding(lineage)), expiresAt });
            if (head && head.current !== key && head.current !== initialKey) retired.add(head.current);
            return next;
          });
        } catch (cause) { failed = true; throw new SessionError('session_store', 'Session publication failed', cause); }
      };
      const mutate = (): void => { ensure(); if (callbackRequest) throw new SessionError('csrf', 'OAuth callbacks only permit code exchange'); };
      const save = async (value: SessionState): Promise<void> => {
        ensure();
        const next: SessionState = { ...value, lineage };
        try { await lease.save({ sealed: await this.#sealer.seal(next, this.#binding(key)), expiresAt: next.expiresAt }); state = next; cookieNeeded = true; }
        catch (cause) { failed = true; throw new SessionError('session_store', 'Session publication failed', cause); }
      };
      const storage: SessionStorage = {
        getItem: async name => { ensure(); if (name === storageKey) return state?.session ?? null; if (name === `${storageKey}.pkce`) return state?.pkce ?? null; throw new SessionError('session_store', 'Unexpected session storage key'); },
        setItem: async (name, value) => {
          ensure();
          const next: SessionState = { schema: 1, session: state?.session ?? null, pkce: state?.pkce ?? null, oauthState: state?.oauthState ?? null, returnTo: state?.returnTo ?? '/', expiresAt: state?.expiresAt ?? Date.now() + this.#ttl * 1000 };
          if (state?.generation !== undefined) next.generation = state.generation;
          if (name === storageKey && identityMutation && published) { ensure(); await rotate(true); }
          if (name === storageKey) {
            next.session = value;
            if (identityMutation) { next.expiresAt = Date.now() + this.#ttl * 1000; next.pkce = null; next.oauthState = null; next.generation = generation = await register(); }
          }
          if (name === `${storageKey}.pkce`) next.pkce = value;
          if (name !== storageKey && name !== `${storageKey}.pkce`) throw new SessionError('session_store', 'Unexpected session storage key');
          await save(next);
        },
        removeItem: async name => {
          ensure(); if (!state) return;
          if (name !== storageKey && name !== `${storageKey}.pkce`) throw new SessionError('session_store', 'Unexpected session storage key');
          await save({ ...state, session: name === storageKey ? null : state.session, pkce: name === `${storageKey}.pkce` ? null : state.pkce, oauthState: name === `${storageKey}.pkce` ? null : state.oauthState });
        },
      };
      const client = this.#client(() => { ensure(); return accessToken(state); }, () => alive && accepting && !lease.signal.aborted, callbackRequest, lease.signal);
      // This auth client owns mutations; data requests use only the authoritative token source.
      const authClient = createClient<Database>(this.#api.href, {
        auth: { autoRefresh: false, storage, storageKey }, timeout: this.#options.timeout ?? 30000, retries: 0,
        fetch: async (input, init) => {
          ensure();
          // Each auth call ends before the lease can no longer save its result.
          const budget = Math.min(this.#options.timeout ?? 30000, lease.deadline - Date.now());
          if (budget < 100) throw new NelcotaError({ status: 0, code: 'lease_exhausted', message: 'The session lease cannot fit another auth request' });
          const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), lease.signal, AbortSignal.timeout(budget)]);
          return (this.#options.fetch ?? globalThis.fetch.bind(globalThis))(input, { ...init, signal, cache: 'no-store', redirect: 'error' });
        },
      });
      const auth = authClient.auth;
      const onlyUser = (result: Result<Session>): Result<User> => result.error ? result : { data: result.data.user, error: null };
      const identity = async <T>(operation: () => Promise<T>): Promise<T> => {
        identityMutation = true;
        try { return await operation(); }
        finally { identityMutation = false; }
      };
      const operations: AuthOperations = {
        getUser: () => { mutate(); return auth.getUser(); },
        signInWithPassword: async (input, options) => { mutate(); return onlyUser(await identity(() => auth.signInWithPassword(input, mutationOptions(options)))); },
        signUp: async (input, options) => { mutate(); const result = await identity(() => auth.signUp(input, mutationOptions(options))); return result.error ? result : { data: { user: result.data.user, confirmationRequired: result.data.session === null }, error: null }; },
        signOut: async options => {
          mutate();
          // Ending a live or superseded identity ends the whole lineage in this browser. A
          // row-less (bootstrap) ID only does so when its lineage already has a head, so
          // random cookies never create lineage records.
          const ending = (state?.session !== null && state?.session !== undefined) || loaded.superseded || (presented && (await this.#head(lineage, undefined, lease)) !== null);
          const result = await auth.signOut(mutationOptions(options));
          if (ending) { generation = await register(); cookieNeeded = true; }
          return result;
        },
        refresh: async options => {
          mutate();
          const request = mutationOptions(options);
          const current = await auth.getSession(request);
          if (current.error) return current;
          if (!current.data) return { data: null, error: null };
          let expiresAt = current.data.expires_at;
          let verified = await auth.getUser(request);
          if (verified.error?.status === 401 || verified.error?.status === 404) {
            const renewed = await auth.refreshSession(request);
            if (renewed.error) return renewed;
            verified = await auth.getUser(request);
            expiresAt = renewed.data.expires_at;
          }
          if (verified.error) return verified;
          return { data: { user: verified.data, expiresAt }, error: null };
        },
        updateUser: (input, options) => { mutate(); return auth.updateUser(input, mutationOptions(options)); },
        requestPasswordReset: (email, options) => { mutate(); return auth.requestPasswordReset(email, mutationOptions(options)); },
        sendMagicLink: (email, options) => { mutate(); return auth.sendMagicLink(email, mutationOptions(options)); },
        resendConfirmation: (email, options) => { mutate(); return auth.resendConfirmation(email, mutationOptions(options)); },
        startOAuth: async input => {
          mutate();
          const next: SessionState = { schema: 1, session: state?.session ?? null, pkce: null, oauthState: newSessionId(), returnTo: safeReturnTo(input.returnTo), expiresAt: state?.expiresAt ?? Date.now() + this.#ttl * 1000 };
          if (state?.generation !== undefined) next.generation = state.generation;
          await save(next);
          return auth.signInWithOAuth({ provider: input.provider, redirect: false, redirectTo: `${this.#origin}${this.#basePath}/auth/callback?state=${next.oauthState}` });
        },
        exchangeCode: async (code, options) => {
          ensure();
          if (!callbackRequest) throw new SessionError('csrf', 'Use the configured OAuth callback context');
          const supplied = new URL(request.url).searchParams.get('state'), expected = state?.oauthState;
          if (!state || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !expected || supplied.length !== expected.length || !equalState(supplied, expected)) throw new SessionError('csrf', 'OAuth callback state did not match');
          await save({ ...state, oauthState: null });
          const result = await identity(() => auth.exchangeCode(code, mutationOptions(options)));
          return result.error ? result : { data: { user: result.data.user, returnTo: safeReturnTo(state?.returnTo) }, error: null };
        },
        verifyEmailLink: async (input, options) => { mutate(); return onlyUser(await identity(() => auth.verifyEmailLink(input, mutationOptions(options)))); },
        resetPassword: async (input, options) => { mutate(); return onlyUser(await identity(() => auth.resetPassword(input, mutationOptions(options)))); },
      };
      const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        if (!accepting || !alive) return Promise.reject(new SessionError('closed_context', 'The request context has ended'));
        if (queued >= 32) return Promise.reject(new SessionError('session_capacity', 'Too many queued auth operations'));
        queued++;
        const running = tail.then(() => { ensure(); return task(); }).finally(() => { queued--; });
        tail = running.then(() => undefined, () => undefined);
        return running;
      };
      const actions: AuthOperations = {
        getUser: () => enqueue(() => operations.getUser()),
        signInWithPassword: (input, options) => enqueue(() => operations.signInWithPassword(input, options)),
        signUp: (input, options) => enqueue(() => operations.signUp(input, options)),
        signOut: options => enqueue(() => operations.signOut(options)),
        refresh: options => enqueue(() => operations.refresh(options)),
        updateUser: (input, options) => enqueue(() => operations.updateUser(input, options)),
        requestPasswordReset: (email, options) => enqueue(() => operations.requestPasswordReset(email, options)),
        sendMagicLink: (email, options) => enqueue(() => operations.sendMagicLink(email, options)),
        resendConfirmation: (email, options) => enqueue(() => operations.resendConfirmation(email, options)),
        startOAuth: input => enqueue(() => operations.startOAuth(input)),
        exchangeCode: (code, options) => enqueue(() => operations.exchangeCode(code, options)),
        verifyEmailLink: (input, options) => enqueue(() => operations.verifyEmailLink(input, options)),
        resetPassword: (input, options) => enqueue(() => operations.resetPassword(input, options)),
      };
      try {
        // Best-effort pre-refresh. A 429/5xx or network failure must not block
        // sign-out/sign-in: keep the stored state and let `work` decide.
        if (!callbackRequest) await auth.getSession();
        return await work({ client: this.#data(client), auth: actions });
      } finally {
        accepting = false;
        try {
          await tail;
          if (failed) throw new SessionError('session_store', 'Session publication failed');
          // Next redirects throw. Accepted session publication still needs its cookie.
          // A lineage-governed response re-checks its head at publication time: if a later
          // sign-in/out of this browser won meanwhile, it neither sets nor clears the cookie
          // (either would overwrite the newer identity) and its own row is tombstoned.
          const head = cookieNeeded && generation !== null ? await this.#head(lineage, undefined, lease) : null;
          const stale = cookieNeeded && generation !== null && (head?.current !== key || head.generation !== generation);
          if (stale && state !== null) {
            try { await lease.save(await this.#tombstone(key, lineage)); }
            catch (cause) { failed = true; throw new SessionError('session_store', 'Session publication failed', cause); }
          }
          if (cookieNeeded && !stale) {
            ensure();
            const keep = state !== null && (state.session !== null || state.pkce !== null);
            try { cookies.set(this.#name, keep ? id : '', { httpOnly: true, secure: this.#secure, sameSite: 'lax', path: '/', maxAge: keep && state ? Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000)) : 0 }); }
            catch (cause) { throw new SessionError('session_store', 'Session cookie publication failed', cause); }
          }
          if (!cookieNeeded && clearPresented && id !== existingId) this.expireCookie(cookies);
        } finally { alive = false; client.dispose(); authClient.dispose(); }
      }
    }); } finally {
      // Best effort: a superseded row is already dead by the lineage check; this only
      // removes its credentials early. It also happens lazily when its ID is presented.
      for (const key of retired) await this.#retire(key).catch(() => undefined);
    }
  }
}
