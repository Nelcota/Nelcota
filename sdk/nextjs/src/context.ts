import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient, type AuthRequestOptions, NelcotaError, type Credentials, type DefaultSchemaName, type FetchLike, type NelcotaClient, type OAuthProvider, type Result, type Session, type SessionStorage, type SignUpInput, type User, type UserUpdate } from '@nelcota/client';
import { SessionError } from './errors.js';
import { requireMutation, safeReturnTo, trustedUrl } from './policy.js';
import { newSessionId, sessionKey, SessionSealer, type SessionState } from './seal.js';
import type { SessionLease, SessionStore } from './store.js';

export interface CookieReader { get(name: string): { value: string } | undefined }
export interface CookieWriter extends CookieReader {
  set(name: string, value: string, options: { path: '/'; httpOnly: true; secure: boolean; sameSite: 'lax'; maxAge: number }): void;
}
export interface NextOptions {
  url: string;
  appOrigin: string;
  keys: readonly string[];
  store: SessionStore;
  allowInsecureDevelopment?: boolean;
  cookieName?: string;
  sessionTtlSeconds?: number;
  timeout?: number;
  fetch?: FetchLike;
}
export type DataClient<Database> = Pick<NelcotaClient<Database, DefaultSchemaName<Database>>, 'from' | 'rpc' | 'storage' | 'url'>;
export interface VerifiedContext<Database> {
  client: DataClient<Database>;
  hasSession: boolean;
  /** A cookie was presented without usable state (missing, expired or unreadable). */
  staleCookie: boolean;
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

/** Configuration/store/key capabilities can be shared; each context is request-owned. */
export class Integration<Database> {
  readonly #api: URL;
  readonly #origin: string;
  readonly #name: string;
  readonly #secure: boolean;
  readonly #ttl: number;
  readonly #namespace: string;
  readonly #options: Omit<NextOptions, 'keys'>;
  readonly #sealer: SessionSealer;
  private constructor(options: NextOptions, sealer: SessionSealer) {
    const { keys: _keys, ...settings } = options;
    this.#options = settings; this.#sealer = sealer;
    const development = options.allowInsecureDevelopment === true;
    this.#api = trustedUrl(options.url, development);
    const app = trustedUrl(options.appOrigin, development, true);
    if (development && !['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) throw new SessionError('configuration', 'Insecure development requires a loopback application origin');
    this.#origin = app.origin; this.#secure = app.protocol === 'https:';
    this.#namespace = `${this.#origin}\0${this.#api.href}`;
    const scope = createHash('sha256').update(this.#namespace).digest('hex').slice(0, 12);
    this.#name = options.cookieName ?? `${this.#secure ? '__Host-nelcota' : 'nelcota-dev'}-${scope}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.#name) || (this.#secure && !this.#name.startsWith('__Host-')) || (!this.#secure && this.#name.startsWith('__Host-'))) throw new SessionError('configuration', 'Invalid host-only session cookie name');
    this.#ttl = options.sessionTtlSeconds ?? 604800;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 300 || this.#ttl > 2592000) throw new SessionError('configuration', 'Session TTL must be between five minutes and thirty days');
    if (!Number.isSafeInteger(options.timeout ?? 30000) || (options.timeout ?? 30000) < 100 || (options.timeout ?? 30000) > 30000) throw new SessionError('configuration', 'Request timeout must be between 100 and 30000 ms');
    if (options.store.durability !== 'shared' && !development) throw new SessionError('configuration', 'Production requires an authoritative shared session store');
  }
  static async create<Database>(options: NextOptions): Promise<Integration<Database>> {
    return new Integration<Database>({ ...options }, await SessionSealer.create(options.keys));
  }
  get origin(): string { return this.#origin; }
  #binding(key: string): string { return `nelcota-next/v1\0${this.#origin}\0${this.#api.href}\0${key}`; }
  /** Unreadable rows (lost keys, tampering, mismatched expiry) count as signed out. */
  async #load(key: string, lease?: SessionLease): Promise<{ state: SessionState | null; unreadable: boolean }> {
    const row = await (lease ? lease.load() : this.#options.store.read(key));
    if (!row) return { state: null, unreadable: false };
    try {
      const state = await this.#sealer.open(row.sealed, this.#binding(key));
      if (row.expiresAt === state.expiresAt) return { state, unreadable: false };
    } catch (cause) { if (!(cause instanceof SessionError)) throw cause; }
    // A row expiring between the store check and open() is expired, not unreadable.
    return { state: null, unreadable: row.expiresAt > Date.now() };
  }
  /** Clears this integration's cookie, e.g. on a proxy redirect for a stale session. */
  expireCookie(cookies: CookieWriter): void {
    try { cookies.set(this.#name, '', { httpOnly: true, secure: this.#secure, sameSite: 'lax', path: '/', maxAge: 0 }); }
    catch (cause) { throw new SessionError('session_store', 'Session cookie publication failed', cause); }
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
          return await send(input, { ...init, signal, cache: 'no-store', redirect: 'error' });
        } finally { clearTimeout(timer); lifetime?.removeEventListener('abort', lost); }
      },
    });
  }
  #data(client: NelcotaClient<Database>): DataClient<Database> {
    return { from: client.from.bind(client), rpc: client.rpc.bind(client), storage: client.storage, url: client.url };
  }
  async read<T>(cookies: CookieReader, work: (context: VerifiedContext<Database>) => Promise<T>): Promise<T> {
    const id = cookies.get(this.#name)?.value ?? '', key = sessionKey(id, this.#namespace);
    const state = key ? (await this.#load(key)).state : null;
    let alive = true;
    const client = this.#client(() => accessToken(state), () => alive, true);
    try { return await work({ client: this.#data(client), hasSession: state?.session !== null && state?.session !== undefined, staleCookie: id !== '' && state === null, getUser: options => client.auth.getUser(options) }); }
    finally { alive = false; client.dispose(); }
  }
  /** Explicit same-origin local reset, usable even when old keys/state are unavailable. */
  async forget(cookies: CookieWriter, request: Request): Promise<void> {
    requireMutation(request.headers, request.method, this.#origin);
    const key = sessionKey(cookies.get(this.#name)?.value ?? '', this.#namespace);
    if (key) await this.#options.store.exclusive(key, lease => lease.remove());
    this.expireCookie(cookies);
  }
  async write<T>(cookies: CookieWriter, request: Request, work: (context: WritableContext<Database>) => Promise<T>, callback = false): Promise<T> {
    // Callback GET only permits the PKCE exchange method, never general mutations.
    const callbackRequest = callback && request.method === 'GET' && new URL(request.url).origin === this.#origin && new URL(request.url).pathname === '/auth/callback';
    if (callback && !callbackRequest) throw new SessionError('csrf', 'Use the configured GET OAuth callback');
    if (!callbackRequest) requireMutation(request.headers, request.method, this.#origin);
    const existingId = cookies.get(this.#name)?.value ?? '';
    const id = sessionKey(existingId, this.#namespace) ? existingId : newSessionId();
    const key = sessionKey(id, this.#namespace);
    if (!key) throw new SessionError('invalid_session', 'Invalid generated session id');
    return this.#options.store.exclusive(key, async lease => {
      const loaded = await this.#load(key, lease);
      let state = loaded.state;
      // Proceed signed out: an unreadable row must not lock the browser out of login.
      if (loaded.unreadable) await lease.remove();
      let alive = true, accepting = true, failed = false, cookieNeeded = false;
      let identityMutation = false;
      let queued = 0, tail: Promise<void> = Promise.resolve();
      const storageKey = `nelcota-next.${key}.session`;
      const ensure = (): void => { if (!alive || failed || lease.signal.aborted) throw new SessionError('closed_context', 'The session context is no longer writable'); };
      const mutate = (): void => { ensure(); if (callbackRequest) throw new SessionError('csrf', 'OAuth callbacks only permit code exchange'); };
      const save = async (next: SessionState): Promise<void> => {
        ensure();
        try { await lease.save({ sealed: await this.#sealer.seal(next, this.#binding(key)), expiresAt: next.expiresAt }); state = next; cookieNeeded = true; }
        catch (cause) { failed = true; throw new SessionError('session_store', 'Session publication failed', cause); }
      };
      const storage: SessionStorage = {
        getItem: async name => { ensure(); if (name === storageKey) return state?.session ?? null; if (name === `${storageKey}.pkce`) return state?.pkce ?? null; throw new SessionError('session_store', 'Unexpected session storage key'); },
        setItem: async (name, value) => {
          ensure();
          const next: SessionState = { schema: 1, session: state?.session ?? null, pkce: state?.pkce ?? null, oauthState: state?.oauthState ?? null, returnTo: state?.returnTo ?? '/', expiresAt: state?.expiresAt ?? Date.now() + this.#ttl * 1000 };
          if (name === storageKey) {
            next.session = value;
            if (identityMutation) { next.expiresAt = Date.now() + this.#ttl * 1000; next.pkce = null; next.oauthState = null; }
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
          const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), lease.signal, AbortSignal.timeout(this.#options.timeout ?? 30000)]);
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
        signOut: async options => { mutate(); return auth.signOut(mutationOptions(options)); },
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
          await save(next);
          return auth.signInWithOAuth({ provider: input.provider, redirect: false, redirectTo: `${this.#origin}/auth/callback?state=${next.oauthState}` });
        },
        exchangeCode: async (code, options) => {
          ensure();
          if (!callbackRequest) throw new SessionError('csrf', 'Use the configured OAuth callback context');
          const supplied = new URL(request.url).searchParams.get('state'), expected = state?.oauthState;
          if (!state || !supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !expected || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new SessionError('csrf', 'OAuth callback state did not match');
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
        if (!callbackRequest) {
          const current = await auth.getSession();
          if (current.error) throw current.error;
        }
        return await work({ client: this.#data(client), auth: actions });
      } finally {
        accepting = false;
        try {
          await tail;
          if (failed) throw new SessionError('session_store', 'Session publication failed');
          // Next redirects throw. Accepted session publication still needs its cookie.
          if (cookieNeeded && !failed) {
            ensure();
            const keep = state !== null && (state.session !== null || state.pkce !== null);
            try { cookies.set(this.#name, keep ? id : '', { httpOnly: true, secure: this.#secure, sameSite: 'lax', path: '/', maxAge: keep && state ? Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000)) : 0 }); }
            catch (cause) { throw new SessionError('session_store', 'Session cookie publication failed', cause); }
          }
          if (!cookieNeeded && loaded.unreadable) this.expireCookie(cookies);
        } finally { alive = false; client.dispose(); authClient.dispose(); }
      }
    });
  }
}
