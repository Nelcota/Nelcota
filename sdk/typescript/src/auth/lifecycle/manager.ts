import { abortable } from "../../core/cancellation.js";
import {
  type NelcotaError,
  NelcotaUsageError,
  clientError,
  fail,
  ok,
  sessionFailure,
  type Result,
} from "../../core/client.errors.js";
import { isBrowser } from "../../core/runtime.js";
import { withLock, sessionLock } from "../browser/coordination.js";
import { retryDelayInMs } from "../scheduler.js";
import { isSession, secondsLeft, type Session, type User } from "../session.js";
import { SessionStore, storageKey } from "../store.js";
import type { AuthListener, AuthOptions, AuthRequestOptions, SessionTransport } from "../types.js";
import { SessionBackground } from "./background.js";
import { SessionPublication } from "./publication.js";
const DEFAULT_REFRESH_MARGIN_SECONDS = 60;
const HTTP_CLIENT_ERROR_START = 400;
const HTTP_SERVER_ERROR_START = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

export type { AuthListener, AuthOptions, AuthRequestOptions } from "../types.js";

// Sign-out renews only an expired token, allowing this much clock skew.
const SIGN_OUT_SKEW = 5;
type Authentication = Session | { user: User; session: Session | null };

/**
 * The session's lifecycle: sign-in, refresh and sign-out transitions under one
 * lock, and the events they announce. Persistence lives in `SessionStore`,
 * timers in `RefreshScheduler` and cross-tab primitives in `coordination`.
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #lockName: string | symbol;
  readonly #pkceLockName: string | symbol;
  readonly #margin: number;
  readonly #lifecycle: SessionBackground;
  readonly #publication: SessionPublication;
  readonly #callerOwned: boolean;
  readonly #onBackgroundError: AuthOptions["onBackgroundError"];
  #refreshing: Promise<Result<Session>> | null = null;
  /** Until then (ms), reads keep a still-valid token instead of retrying a failed refresh. */
  #retryAt = 0;

  constructor(
    url: URL,
    options: AuthOptions,
    private readonly transport: SessionTransport,
  ) {
    const { accessToken } = transport;
    this.#callerOwned = accessToken !== undefined;
    const margin = options.refreshMargin ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    if (Number.isFinite(margin) === false || margin < 0)
      throw new NelcotaUsageError("refreshMargin must be a finite non-negative number");
    this.#margin = margin;
    const browser = isBrowser();
    const store = (this.#store = new SessionStore(
      options.storageKey ?? storageKey(url),
      options.storage,
    ));
    this.#lockName = sessionLock(store.storage, store.key, {
      browser,
      supplied: options.storage != null,
    });
    this.#pkceLockName = sessionLock(store.storage, store.key, {
      browser,
      supplied: options.storage != null,
      kind: "pkce",
    });
    this.#onBackgroundError = options.onBackgroundError;
    this.#lifecycle = new SessionBackground({
      store,
      browser,
      callerOwned: this.#callerOwned,
      refresh: accessToken == null && (options.autoRefresh ?? browser),
      marginFor: (session) => this.#marginFor(session),
      locked: (task) => this.#locked(task),
      current: () => this.current(),
      // The scheduler owns its own retry delays, so it sees every refresh failure.
      get: () => this.#get({}, false),
      reload: (event, revision) => this.#publication.reload(event, revision),
      onError: (error) => this.#onBackgroundError?.(error),
    });
    this.#publication = new SessionPublication({
      store,
      lifecycle: this.#lifecycle,
      locked: (task) => this.#locked(task),
    });
  }

  withVerifier<T>(task: () => Promise<T>): Promise<T> {
    return withLock(this.#pkceLockName, task);
  }
  setVerifier(value: string): Promise<void> {
    return this.#store.setVerifier(value);
  }
  peekVerifier(): Promise<string | null> {
    return this.#store.peekVerifier();
  }
  consumeVerifier(): Promise<string | null> {
    return this.#store.consumeVerifier();
  }

  onChange(listener: AuthListener): () => void {
    return this.#lifecycle.onChange(listener);
  }

  #locked<T>(task: () => Promise<T>): Promise<T> {
    return withLock(this.#lockName, task);
  }
  current(): Promise<Session | null> {
    return this.#locked(() => this.#store.read());
  }
  #marginFor(session: Session): number {
    // A short-lived token or a large configured margin must not make every
    // request (or every background tick) rotate a freshly issued token.
    return Math.min(this.#margin, session.expires_in / 2);
  }
  set(session: Session): Promise<void> {
    if (isSession(session) === false) throw new NelcotaUsageError("Not a Nelcota session");
    return this.#locked(async () => {
      if (this.#store.journaled) await this.#store.read(true);
      await this.#publication.write(session, "signed_in");
    });
  }
  async authenticate<T extends Authentication>(
    request: () => Promise<Result<T>>,
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    if (signal?.aborted === true) return fail(clientError("aborted", "The request was aborted"));
    let entry: typeof request | undefined = request;
    const result = await abortable(
      this.#locked(async () => {
        const task = entry;
        entry = undefined;
        if (task == null) return fail(clientError("aborted", "The request was aborted"));
        // Capture the receipt before HTTP: failed publication must retain an
        // accepted sign-in until that exact receipt is superseded.
        if (this.#store.journaled) await this.#store.read(true);
        const result = await task();
        if (result.error != null) return result;
        const data: Authentication = result.data;
        const session = isSession(data) ? data : data.session;
        if (session != null) await this.#publication.write(session, "signed_in");
        return result;
      }),
      signal,
      () => {
        entry = undefined;
      },
    );
    return result.data ?? result;
  }
  /**
   * The session, refreshed when it is within the margin. A transient refresh
   * failure (network, 429, 5xx, another tab's pending rotation) keeps
   * a still-valid access token: the read succeeds and further foreground
   * attempts wait for `Retry-After` or a short backoff. An expired token
   * returns the failure instead of being sent.
   */
  get(options: AuthRequestOptions = {}): Promise<Result<Session | null>> {
    return this.#get(options, true);
  }
  async #get(options: AuthRequestOptions, tolerant: boolean): Promise<Result<Session | null>> {
    if (options.signal?.aborted === true)
      return fail(clientError("aborted", "The request was aborted"));
    const current = await abortable(this.current(), options.signal).catch((error: unknown) =>
      fail(sessionFailure(error)),
    );
    if (current.error != null) return fail(current.error);
    const session = current.data;
    if (session == null || secondsLeft(session) > this.#marginFor(session)) return ok(session);
    const usable = tolerant && secondsLeft(session) > 0 ? session : null;
    if (usable != null && Date.now() < this.#retryAt) return ok(usable);
    return this.#settle(await this.refresh(options, session), usable);
  }
  /** A refresh outcome as a read: `usable` is the still-valid session to keep on a transient failure. */
  #settle(refreshed: Result<Session>, usable: Session | null): Result<Session | null> {
    const failure = refreshed.error;
    if (failure == null) {
      this.#retryAt = 0;
      return refreshed;
    }
    if (failure.code === "invalid_grant" || failure.code === "session_missing") return ok(null);
    if (usable == null || transient(failure) === false) return refreshed;
    this.#retryAt = Date.now() + retryDelayInMs(failure.retryAfter);
    return ok(usable);
  }
  async accessToken(): Promise<string | null> {
    const result = await this.get();
    if (result.error != null) throw result.error;
    return result.data?.access_token ?? null;
  }
  refresh(options: AuthRequestOptions = {}, snapshot?: Session): Promise<Result<Session>> {
    if (options.signal?.aborted === true)
      return Promise.resolve(fail(clientError("aborted", "The request was aborted")));
    this.#refreshing ??= (async () => {
      // A broadcast can reload a replacement after get() observed expiry.
      // Compare with that original session instead of rotating its replacement.
      const known = snapshot ?? this.#store.hint() ?? (await this.current());
      if (known == null) return fail(clientError("session_missing", "Not signed in"));
      return await this.#locked(async () => {
        const current = await this.#store.read(true);
        if (current == null) return fail(clientError("session_missing", "Not signed in"));
        if (
          current.refresh_token !== known.refresh_token &&
          secondsLeft(current) > this.#marginFor(current)
        )
          return ok(current);
        return await this.#rotate(current, options);
      });
    })()
      .catch((error: unknown) => fail(sessionFailure(error)))
      .finally(() => {
        this.#refreshing = null;
      });
    return abortable(this.#refreshing, options.signal).then((result) => result.data ?? result);
  }
  async #rotate(
    current: Session,
    options: AuthRequestOptions,
    publish = true,
  ): Promise<Result<Session>> {
    const pending = await this.#store.reserve(current);
    if (pending != null) return fail(pending);
    // Accepted rotation owns publication independently of a cancelled waiter.
    // The reservation is renewed while the request runs, up to a bounded hold.
    const stopRenewal = this.#store.holdReservation(options.timeout ?? this.transport.timeout);
    let result: Result<Session>;
    try {
      result = await this.transport.rotate(
        current.refresh_token,
        options.timeout === undefined ? {} : { timeout: options.timeout },
      );
    } finally {
      await stopRenewal?.();
    }
    if (result.error != null) {
      await this.#rejected(current, result.error, publish);
      return result;
    }
    if (publish) await this.#publication.write(result.data, "refreshed", true);
    return result;
  }
  async #rejected(current: Session, error: NelcotaError, publish: boolean): Promise<void> {
    if (error.code === "invalid_grant") {
      if (publish) await this.#publication.write(null, "signed_out", true);
      return;
    }
    // Every other 4xx is returned before the rotation commits (rate limit,
    // malformed request), so the stored token is still valid. A 5xx can
    // follow an ambiguous commit and a lost response has no answer at all:
    // preserve their reservation.
    if (error.status >= HTTP_CLIENT_ERROR_START && error.status < HTTP_SERVER_ERROR_START)
      await this.#store.release(current);
  }
  rememberUser(snapshot: Session): (user: User) => Promise<void> {
    return this.#publication.rememberUser(snapshot);
  }
  signOut(
    request: (session: Session) => Promise<Result<null>>,
    options: AuthRequestOptions = {},
  ): Promise<Result<null>> {
    return this.#locked(async () => {
      try {
        const session = await this.#store.read(true);
        // The only transition: sign-out never publishes or announces a renewal.
        if (session != null) return await this.#endSession(session, request, options);
        if (this.#store.dirty) await this.#publication.persist();
        this.#lifecycle.schedule(null);
        return ok(null);
      } finally {
        // Match exchangeCode's lifecycle -> PKCE lock order. Consume commits a
        // null receipt before removing the potentially stale native mirror.
        await this.withVerifier(() => this.consumeVerifier());
      }
    });
  }
  async #endSession(
    session: Session,
    request: (session: Session) => Promise<Result<null>>,
    options: AuthRequestOptions,
  ): Promise<Result<null>> {
    try {
      return await this.#revoke(session, request, options);
    } finally {
      await this.#publication.write(null, "signed_out");
    }
  }
  async #revoke(
    session: Session,
    request: (session: Session) => Promise<Result<null>>,
    options: AuthRequestOptions,
  ): Promise<Result<null>> {
    if (
      this.#store.pending ||
      options.signal?.aborted === true ||
      secondsLeft(session) > SIGN_OUT_SKEW
    )
      return await request(session);
    // Renew an expired token only to revoke its replacement, which stays in memory.
    let renewed: Result<Session> | undefined, failure: unknown;
    try {
      renewed = await this.#rotate(session, options, false);
    } catch (error) {
      failure = error;
    }
    if (renewed != null && renewed.error == null) return await request(renewed.data);
    if (secondsLeft(session) > 0) return await request(session);
    if (renewed != null) return fail(renewed.error);
    throw failure;
  }
  dispose(): void {
    this.#lifecycle.dispose();
  }
}

/** A failure that a later attempt can fix, unlike a refusal or a cancellation. */
function transient(error: NelcotaError): boolean {
  // Cancellation is the caller's; a storage failure is reported, not hidden.
  if (error.code === "aborted" || error.code === "session_unavailable") return false;
  return (
    error.status === 0 ||
    error.status === HTTP_TOO_MANY_REQUESTS ||
    error.status >= HTTP_SERVER_ERROR_START
  );
}
