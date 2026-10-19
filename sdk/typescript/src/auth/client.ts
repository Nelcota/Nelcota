/**
 * Sign-up, sign-in (password, OAuth with PKCE, email links) and the session's
 * life: stored, refreshed before it expires, shared across tabs.
 */

import { NelcotaError, NelcotaUsageError, clientError, fail, ok, type Result } from '../core/errors.js';
import type { HttpClient } from '../core/http.js';
import { isBrowser } from '../core/jwt.js';
import { SessionManager, type AuthListener, type AuthOptions, type AuthRequestOptions } from './manager.js';
export type { AuthEvent, AuthListener, AuthOptions, AuthRequestOptions } from './manager.js';
import { challengeFor, createVerifier } from './pkce.js';
import { withLock } from './coordination.js';
import { isSession, isUser, type Session, type User } from './session.js';

export type OAuthProvider = 'google' | 'github';
export type EmailLinkType = 'recovery' | 'signup' | 'magiclink';

export interface Credentials {
  email: string;
  password: string;
}

export interface SignUpInput extends Credentials {
  /** Becomes `user_metadata`. Never trust it for authorization. */
  data?: Record<string, unknown>;
}

export interface UserUpdate {
  /** New password (same rules as sign-up). */
  password?: string;
  /** Required with `password` when the account already has one. */
  currentPassword?: string;
  /**
   * Merged into `user_metadata` one level deep; a key set to `null` is
   * removed. Never trust it for authorization.
   */
  data?: Record<string, unknown>;
}

export interface OAuthInput {
  provider: OAuthProvider;
  /** App page to come back to; must be allowed in NELCOTA_OAUTH_REDIRECT_URLS. */
  redirectTo: string;
  /** Navigate there right away (browsers only). Default true in browsers. */
  redirect?: boolean;
}

export interface EmailLink {
  type: EmailLinkType;
  token: string;
}

const LINK_TYPES = new Set<string>(['recovery', 'signup', 'magiclink']);
function email(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NelcotaUsageError('An email is required');
  return value.trim();
}

export class AuthClient {
  readonly #http: HttpClient;
  readonly #manager: SessionManager;

  constructor(http: HttpClient, options: AuthOptions = {}) {
    this.#http = http;
    this.#manager = new SessionManager(http.url, options, (token, request) =>
      this.#token('refresh_token', { refresh_token: token }, request));
  }

  onChange(listener: AuthListener): () => void { return this.#manager.onChange(listener); }
  dispose(): void { this.#manager.dispose(); }
  getSession(options: AuthRequestOptions = {}): Promise<Result<Session | null>> { return this.#manager.get(options); }
  accessToken(): Promise<string | null> { return this.#manager.accessToken(); }
  refreshSession(options: AuthRequestOptions = {}): Promise<Result<Session>> { return this.#manager.refresh(options); }
  async setSession(session: Session): Promise<void> {
    await this.#manager.set(session);
  }
  // --------------------------------------------------------------- sign in

  async #token(grant: 'password' | 'refresh_token' | 'pkce', body: Record<string, string>, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    const result = await this.#http.json<unknown>({
      method: 'POST',
      path: '/auth/v1/token',
      query: new URLSearchParams({ grant_type: grant }),
      json: body,
      auth: false,
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error) return fail(result.error);
    return isSession(result.data) ? ok(result.data) : fail(invalidResponse());
  }

  /** Creates an account. `session` is `null` while the email awaits confirmation. */
  async signUp(input: SignUpInput, options: AuthRequestOptions = {}): Promise<Result<{ user: User; session: Session | null }>> {
    const body: Record<string, unknown> = { email: email(input.email), password: input.password };
    if (input.data !== undefined) body['data'] = input.data;
    return this.#manager.authenticate<{ user: User; session: Session | null }>(async () => {
      const result = await this.#http.json<unknown>({ method: 'POST', path: '/auth/v1/signup', json: body, auth: false, signal: options.signal, timeout: options.timeout });
      if (result.error) return fail(result.error);
      if (isSession(result.data)) return ok({ user: result.data.user, session: result.data });
      const user = (result.data as { user?: unknown } | null)?.user;
      return isUser(user) ? ok({ user, session: null }) : fail(invalidResponse());
    }, data => data.session, options.signal);
  }

  async signInWithPassword(credentials: Credentials, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    const body = { email: email(credentials.email), password: credentials.password };
    return this.#manager.authenticate(() => this.#token('password', body, options), session => session, options.signal);
  }

  /**
   * Starts a Google/GitHub sign-in. The PKCE verifier stays in this
   * browser's storage; the app finishes on `redirectTo` with `handleRedirect()`.
   */
  async signInWithOAuth(input: OAuthInput): Promise<Result<{ url: string }>> {
    const redirectTo = absoluteUrl(input.redirectTo, 'redirectTo').href;
    const provider = input.provider, redirect = input.redirect ?? true;
    const key = `${this.#manager.key}.pkce`;
    return withLock(key, async () => {
      const verifier = createVerifier();
      const challenge = await challengeFor(verifier);
      await this.#manager.setVerifier(verifier);
      const query = new URLSearchParams({
        provider,
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const url = this.#http.href('/auth/v1/authorize', query);
      if (redirect && isBrowser()) globalThis.location.assign(url);
      return ok({ url });
    });
  }

  /** Trades the `code` from the OAuth redirect (and the stored verifier) for a session. */
  async exchangeCode(code: string, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    return this.#manager.authenticate(async () => {
      const key = `${this.#manager.key}.pkce`;
      const verifier = await withLock(key, async () => {
        if (options.signal?.aborted) return null;
        // Claim once before HTTP; the exchange then owns its bounded lifetime.
        return this.#manager.consumeVerifier();
      });
      if (!verifier && options.signal?.aborted) return fail(clientError('aborted', 'The request was aborted'));
      if (!verifier) return fail(clientError('pkce_missing', 'PKCE verifier missing; restart sign-in'));
      return this.#token('pkce', { auth_code: code, code_verifier: verifier }, options.timeout === undefined ? {} : { timeout: options.timeout });
    }, session => session, options.signal);
  }

  /**
   * Finishes an OAuth sign-in on the `redirectTo` page: reads `?code=` or
   * `?error=`, removes them from the address bar and history, and signs in.
   * Returns `null` data when the URL carries neither.
   */
  async handleRedirect(href: string = globalThis.location?.href ?? '', options: AuthRequestOptions = {}): Promise<Result<Session | null>> {
    if (href === '') return ok(null);
    const url = absoluteUrl(href, 'URL');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code === null && error === null) return ok(null);
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    replaceUrl(href, url);
    if (error !== null) {
      return fail(new NelcotaError({ status: 0, code: error, message: `Sign-in failed: ${error}` }));
    }
    return this.exchangeCode(code ?? '', options);
  }

  /**
   * Reads an email link's fragment (`#type=...&token=...`) and removes it
   * from the address bar and history, so the token cannot leak later.
   * Then call `verifyEmailLink` or, for `recovery`, `resetPassword`.
   */
  readEmailLink(href: string = globalThis.location?.href ?? ''): EmailLink | null {
    if (href === '') return null;
    const url = absoluteUrl(href, 'URL');
    const params = new URLSearchParams(url.hash.slice(1));
    const type = params.get('type');
    const token = params.get('token');
    if (type === null || token === null || !LINK_TYPES.has(type) || token.length === 0 || token.length > 128) {
      return null;
    }
    url.hash = '';
    replaceUrl(href, url);
    return { type: type as EmailLinkType, token };
  }

  /** Confirms a sign-up or signs in with a magic link. */
  async verifyEmailLink(link: { type: 'signup' | 'magiclink'; token: string }, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    return this.#verify({ type: link.type, token: link.token }, options);
  }

  /** Sets a new password from a recovery link; other sessions end. */
  async resetPassword(input: { token: string; password: string }, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    return this.#verify({ type: 'recovery', token: input.token, password: input.password }, options);
  }

  async #verify(body: Record<string, string>, options: AuthRequestOptions): Promise<Result<Session>> {
    return this.#manager.authenticate(async () => {
      const result = await this.#http.json<unknown>({ method: 'POST', path: '/auth/v1/verify', json: body, auth: false, signal: options.signal, timeout: options.timeout });
      if (result.error) return fail(result.error);
      return isSession(result.data) ? ok(result.data) : fail(invalidResponse());
    }, session => session, options.signal);
  }

  async #emailOnly(path: string, body: Record<string, string>, options: AuthRequestOptions): Promise<Result<null>> {
    const result = await this.#http.json<unknown>({ method: 'POST', path, json: body, auth: false, signal: options.signal, timeout: options.timeout });
    return result.error ? fail(result.error) : ok(null);
  }

  /** Emails a recovery link. Answers the same whether or not the account exists. */
  requestPasswordReset(address: string, options: AuthRequestOptions = {}): Promise<Result<null>> {
    return this.#emailOnly('/auth/v1/recover', { email: email(address) }, options);
  }

  /** Emails a passwordless sign-in link. */
  sendMagicLink(address: string, options: AuthRequestOptions = {}): Promise<Result<null>> {
    return this.#emailOnly('/auth/v1/magiclink', { email: email(address) }, options);
  }

  /** Sends the sign-up confirmation email again. */
  resendConfirmation(address: string, options: AuthRequestOptions = {}): Promise<Result<null>> {
    return this.#emailOnly('/auth/v1/resend', { type: 'signup', email: email(address) }, options);
  }

  // ---------------------------------------------------------------- user

  /** The signed-in user as the server sees it now. */
  async getUser(options: AuthRequestOptions = {}): Promise<Result<User>> {
    const { data: session, error } = await this.getSession(options);
    if (error) return fail(error);
    if (!session) return fail(clientError('session_missing', 'Not signed in'));
    const result = await this.#http.json<unknown>({ method: 'GET', path: '/auth/v1/user', auth: session.access_token, signal: options.signal, timeout: options.timeout });
    if (result.error) return fail(result.error);
    if (!isUser(result.data)) return fail(invalidResponse());
    await this.#manager.updateUser(session, result.data);
    return ok(result.data);
  }

  /**
   * Changes the signed-in user's password and/or `user_metadata`. A password
   * change ends the user's other sessions; this one keeps working.
   */
  async updateUser(input: UserUpdate, options: AuthRequestOptions = {}): Promise<Result<User>> {
    if (input.password === undefined && input.data === undefined) throw new NelcotaUsageError('updateUser needs password or data');
    const body: Record<string, unknown> = {};
    if (input.password !== undefined) body['password'] = input.password;
    if (input.currentPassword !== undefined) body['current_password'] = input.currentPassword;
    if (input.data !== undefined) body['data'] = input.data;
    const { data: session, error } = await this.getSession(options);
    if (error) return fail(error);
    if (!session) return fail(clientError('session_missing', 'Not signed in'));
    const result = await this.#http.json<unknown>({ method: 'PUT', path: '/auth/v1/user', json: body, auth: session.access_token, signal: options.signal, timeout: options.timeout });
    if (result.error) return fail(result.error);
    if (!isUser(result.data)) return fail(invalidResponse());
    await this.#manager.updateUser(session, result.data);
    return ok(result.data);
  }

  /**
   * Ends the session on the server (its refresh tokens stop working) and
   * forgets it here. The current access token stays valid until it expires.
   */
  async signOut(options: AuthRequestOptions = {}): Promise<Result<null>> {
    return this.#manager.signOut(async session => {
      const result = await this.#http.send({ method: 'POST', path: '/auth/v1/logout', auth: session.access_token, signal: options.signal, timeout: options.timeout });
      return result.error ? fail(result.error) : ok(null);
    });
  }
}

function absoluteUrl(value: string, what: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new NelcotaUsageError(`${what} must be an absolute URL`);
  }
}

function invalidResponse(): NelcotaError {
  return clientError('invalid_response', 'Invalid auth response');
}

/** Rewrites the address bar, only when `original` is the page being shown. */
function replaceUrl(original: string, url: URL): void {
  if (!isBrowser() || globalThis.location?.href !== original) return;
  try {
    globalThis.history.replaceState(globalThis.history.state, '', url.href);
  } catch {
    // A different origin or a sandboxed frame: nothing to clean.
  }
}
