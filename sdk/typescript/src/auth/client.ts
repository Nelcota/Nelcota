import {
  type NelcotaError,
  NelcotaUsageError,
  clientError,
  fail,
  ok,
  type Result,
} from "../core/client.errors.js";
import { isBrowser } from "../core/runtime.js";
/**
 * Sign-up, sign-in (password, OAuth with PKCE, email links) and the session's
 * life: stored, refreshed before it expires, shared across tabs.
 */
import type { HttpClient } from "../core/http/client.js";
import { SessionManager } from "./lifecycle/manager.js";
import { absoluteUrl, clearOAuthRedirect, parseEmailLink, readOAuthRedirect } from "./redirects.js";
import { isSession, isUser, type Session, type User } from "./session.js";
import type {
  AuthListener,
  AuthOptions,
  AuthRequestOptions,
  Credentials,
  EmailLink,
  OAuthInput,
  SignUpInput,
  UserUpdate,
} from "./types.js";
export type {
  AuthEvent,
  AuthListener,
  AuthOptions,
  AuthRequestOptions,
  Credentials,
  EmailLink,
  EmailLinkType,
  OAuthInput,
  OAuthProvider,
  SignUpInput,
  UserUpdate,
} from "./types.js";
import { challengeFor, createVerifier } from "./pkce.js";
function email(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new NelcotaUsageError("An email is required");
  return value.trim();
}

export class AuthClient {
  readonly #http: HttpClient;
  readonly #manager: SessionManager;

  constructor(http: HttpClient, options: AuthOptions = {}) {
    this.#http = http;
    this.#manager = new SessionManager(http.url, options, {
      rotate: (token, request) => this.#token("refresh_token", { refresh_token: token }, request),
      accessToken: http.accessToken,
    });
  }

  onChange(listener: AuthListener): () => void {
    return this.#manager.onChange(listener);
  }
  dispose(): void {
    this.#manager.dispose();
  }
  getSession(options: AuthRequestOptions = {}): Promise<Result<Session | null>> {
    return this.#manager.get(options);
  }
  accessToken(): Promise<string | null> {
    return this.#manager.accessToken();
  }
  refreshSession(options: AuthRequestOptions = {}): Promise<Result<Session>> {
    return this.#manager.refresh(options);
  }
  async setSession(session: Session): Promise<void> {
    await this.#manager.set(session);
  }
  // --------------------------------------------------------------- sign in

  async #token(
    grant: "password" | "refresh_token" | "pkce",
    body: Record<string, string>,
    options: AuthRequestOptions = {},
  ): Promise<Result<Session>> {
    const result = await this.#http.json<unknown>({
      method: "POST",
      path: "/auth/v1/token",
      query: new URLSearchParams({ grant_type: grant }),
      json: body,
      auth: false,
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error != null) return fail(result.error);
    return isSession(result.data) ? ok(result.data) : fail(invalidResponse());
  }

  /** Creates an account. `session` is `null` while the email awaits confirmation. */
  async signUp(
    input: SignUpInput,
    options: AuthRequestOptions = {},
  ): Promise<Result<{ user: User; session: Session | null }>> {
    const body: Record<string, unknown> = { email: email(input.email), password: input.password };
    if (input.data !== undefined) body["data"] = input.data;
    return await this.#manager.authenticate<{ user: User; session: Session | null }>(async () => {
      const result = await this.#http.json<unknown>({
        method: "POST",
        path: "/auth/v1/signup",
        json: body,
        auth: false,
        signal: options.signal,
        timeout: options.timeout,
      });
      if (result.error != null) return fail(result.error);
      if (isSession(result.data)) return ok({ user: result.data.user, session: result.data });
      const user = (result.data as { user?: unknown } | null)?.user;
      return isUser(user) ? ok({ user, session: null }) : fail(invalidResponse());
    }, options.signal);
  }

  /**
   * Signs in with email and password. A wrong email or password fails with
   * `invalid_grant` (400), the same code for both; an account still waiting
   * for its confirmation link fails with `email_not_confirmed`.
   */
  async signInWithPassword(
    credentials: Credentials,
    options: AuthRequestOptions = {},
  ): Promise<Result<Session>> {
    const body = { email: email(credentials.email), password: credentials.password };
    return await this.#manager.authenticate(
      () => this.#token("password", body, options),
      options.signal,
    );
  }

  /**
   * Starts a Google/GitHub sign-in. The PKCE verifier stays in this
   * browser's storage; the app finishes on `redirectTo` with `handleRedirect()`.
   */
  async signInWithOAuth(input: OAuthInput): Promise<Result<{ url: string }>> {
    const redirectTo = absoluteUrl(input.redirectTo, "redirectTo").href;
    const provider = input.provider,
      redirect = input.redirect ?? true;
    return await this.#manager.withVerifier(async () => {
      const verifier = createVerifier();
      const challenge = await challengeFor(verifier);
      await this.#manager.setVerifier(verifier);
      const query = new URLSearchParams({
        provider,
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const url = this.#http.href("/auth/v1/authorize", query);
      if (redirect && isBrowser()) globalThis.location.assign(url);
      return ok({ url });
    });
  }

  /** Trades the `code` from the OAuth redirect (and the stored verifier) for a session. */
  async exchangeCode(code: string, options: AuthRequestOptions = {}): Promise<Result<Session>> {
    if (typeof code !== "string" || code.trim() === "")
      throw new NelcotaUsageError("An OAuth code is required");
    return await this.#manager.authenticate(
      () =>
        // The verifier lock spans the exchange: no other callback can use it,
        // and a new sign-in cannot replace it until this answer is known.
        this.#manager.withVerifier(async () => {
          if (options.signal?.aborted === true)
            return fail(clientError("aborted", "The request was aborted"));
          const verifier = await this.#manager.peekVerifier();
          if (verifier == null || verifier === "")
            return fail(clientError("pkce_missing", "PKCE verifier missing; restart sign-in"));
          // The exchange owns its bounded lifetime once it starts.
          const result = await this.#token(
            "pkce",
            { auth_code: code, code_verifier: verifier },
            options.timeout === undefined ? {} : { timeout: options.timeout },
          );
          // A definite answer ends this sign-in; an uncertain one (network,
          // timeout, 5xx) keeps the verifier so the same callback can retry.
          if (result.error == null || definiteRefusal(result.error))
            await this.#manager.consumeVerifier();
          return result;
        }),
      options.signal,
    );
  }

  /**
   * Finishes an OAuth sign-in on the `redirectTo` page: reads `?code=` or
   * `?error=`, removes them from the address bar and history, and signs in.
   * Returns `null` data, leaving the URL untouched, when the URL carries
   * neither or no sign-in started here is waiting (no stored PKCE verifier):
   * a `code` parameter of the app's own is not an OAuth callback.
   */
  async handleRedirect(
    href: string = (globalThis as { location?: Location }).location?.href ?? "",
    options: AuthRequestOptions = {},
  ): Promise<Result<Session | null>> {
    const redirect = readOAuthRedirect(href);
    if (redirect.kind === "none") return ok(null);
    const pending = await this.#manager.withVerifier(() => this.#manager.peekVerifier());
    if (pending == null || pending === "") return ok(null);
    clearOAuthRedirect(href);
    if (redirect.kind === "code") return await this.exchangeCode(redirect.code, options);
    // The provider ended this sign-in: its verifier cannot be used again.
    await this.#manager.withVerifier(() => this.#manager.consumeVerifier());
    return fail(redirect.error);
  }

  /**
   * Reads an email link's fragment (`#type=...&token=...`) and removes it
   * from the address bar and history, so the token cannot leak later.
   * Then call `verifyEmailLink` or, for `recovery`, `resetPassword`.
   */
  readEmailLink(
    href: string = (globalThis as { location?: Location }).location?.href ?? "",
  ): EmailLink | null {
    return parseEmailLink(href);
  }

  /** Confirms a sign-up or signs in with a magic link. */
  async verifyEmailLink(
    link: { type: "signup" | "magiclink"; token: string },
    options: AuthRequestOptions = {},
  ): Promise<Result<Session>> {
    return await this.#verify({ type: link.type, token: link.token }, options);
  }

  /** Sets a new password from a recovery link; other sessions end. */
  async resetPassword(
    input: { token: string; password: string },
    options: AuthRequestOptions = {},
  ): Promise<Result<Session>> {
    return await this.#verify(
      { type: "recovery", token: input.token, password: input.password },
      options,
    );
  }

  #verify(body: Record<string, string>, options: AuthRequestOptions): Promise<Result<Session>> {
    return this.#manager.authenticate(async () => {
      const result = await this.#http.json<unknown>({
        method: "POST",
        path: "/auth/v1/verify",
        json: body,
        auth: false,
        signal: options.signal,
        timeout: options.timeout,
      });
      if (result.error != null) return fail(result.error);
      return isSession(result.data) ? ok(result.data) : fail(invalidResponse());
    }, options.signal);
  }

  async #emailOnly(
    path: string,
    body: Record<string, string>,
    options: AuthRequestOptions,
  ): Promise<Result<null>> {
    const result = await this.#http.json<unknown>({
      method: "POST",
      path,
      json: body,
      auth: false,
      signal: options.signal,
      timeout: options.timeout,
    });
    return result.error != null ? fail(result.error) : ok(null);
  }

  /** Emails a recovery link. Answers the same whether or not the account exists. */
  async requestPasswordReset(
    address: string,
    options: AuthRequestOptions = {},
  ): Promise<Result<null>> {
    return await this.#emailOnly("/auth/v1/recover", { email: email(address) }, options);
  }

  /** Emails a passwordless sign-in link. */
  async sendMagicLink(address: string, options: AuthRequestOptions = {}): Promise<Result<null>> {
    return await this.#emailOnly("/auth/v1/magiclink", { email: email(address) }, options);
  }

  /** Sends the sign-up confirmation email again. */
  async resendConfirmation(
    address: string,
    options: AuthRequestOptions = {},
  ): Promise<Result<null>> {
    return await this.#emailOnly(
      "/auth/v1/resend",
      { type: "signup", email: email(address) },
      options,
    );
  }

  // ---------------------------------------------------------------- user

  /** The signed-in user as the server sees it now. */
  async getUser(options: AuthRequestOptions = {}): Promise<Result<User>> {
    return await this.#user("GET", undefined, options);
  }

  /**
   * Changes the signed-in user's password and/or `user_metadata`. A password
   * change ends the user's other sessions; this one keeps working.
   */
  async updateUser(input: UserUpdate, options: AuthRequestOptions = {}): Promise<Result<User>> {
    if (input.password === undefined && input.data === undefined)
      throw new NelcotaUsageError("updateUser needs password or data");
    const body: Record<string, unknown> = {};
    if (input.password !== undefined) body["password"] = input.password;
    if (input.currentPassword !== undefined) body["current_password"] = input.currentPassword;
    if (input.data !== undefined) body["data"] = input.data;
    return await this.#user("PUT", body, options);
  }

  async #user(
    method: "GET" | "PUT",
    body: Record<string, unknown> | undefined,
    options: AuthRequestOptions,
  ): Promise<Result<User>> {
    // Caller-owned tokens never read or update a different stored session.
    const { data: session, error } = await (this.#http.accessToken != null
      ? ok(null)
      : this.getSession(options));
    if (error != null) return fail(error);
    const remember = session != null ? this.#manager.rememberUser(session) : undefined;
    const result = await this.#http.json<unknown>({
      method,
      path: "/auth/v1/user",
      json: body,
      auth: session?.access_token ?? true,
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error != null) return fail(result.error);
    if (isUser(result.data) === false) return fail(invalidResponse());
    await remember?.(result.data);
    return ok(result.data);
  }

  /**
   * Ends the session on the server (its refresh tokens stop working) and
   * forgets it here. The current access token stays valid until it expires.
   */
  async signOut(options: AuthRequestOptions = {}): Promise<Result<null>> {
    return await this.#manager.signOut(async (session) => {
      const result = await this.#http.send({
        method: "POST",
        path: "/auth/v1/logout",
        auth: session.access_token,
        signal: options.signal,
        timeout: options.timeout,
      });
      return result.error != null ? fail(result.error) : ok(null);
    }, options);
  }
}

function invalidResponse(): NelcotaError {
  return clientError("invalid_response", "Invalid auth response");
}

const HTTP_CLIENT_ERROR_START = 400;
const HTTP_SERVER_ERROR_START = 500;

/** The server refused the request (4xx): repeating it cannot succeed. */
function definiteRefusal(error: NelcotaError): boolean {
  return error.status >= HTTP_CLIENT_ERROR_START && error.status < HTTP_SERVER_ERROR_START;
}
