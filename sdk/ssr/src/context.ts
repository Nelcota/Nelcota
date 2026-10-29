import type { NelcotaClient } from "@nelcota/client";

import { SessionError } from "./errors.js";
import { requireMutation } from "./http/policy.js";
import { requestClient, dataClient } from "./http/scoped-client.js";
import { SessionRecords } from "./sealing/records.js";
import { newSessionId, sessionKey } from "./sealing/seal.js";
import { accessToken } from "./session/mutation-options.js";
import type {
  CookieReader,
  CookieWriter,
  SessionOptions,
  DataClient,
  VerifiedContext,
  WritableContext,
} from "./session/types.js";
import { writeSession } from "./session/writer.js";
export type {
  CookieReader,
  CookieWriter,
  SessionOptions,
  DataClient,
  VerifiedContext,
  MutationOptions,
  AuthOperations,
  WritableContext,
} from "./session/types.js";

/** Configuration/store/key capabilities can be shared; each context is request-owned. */
export class Integration<Database = unknown> {
  readonly #records: SessionRecords;
  readonly #config: SessionRecords["config"];
  private constructor(records: SessionRecords) {
    this.#records = records;
    this.#config = records.config;
  }
  static async create<Database = unknown>(options: SessionOptions): Promise<Integration<Database>> {
    return new Integration<Database>(await SessionRecords.create(options));
  }
  get origin(): string {
    return this.#config.origin;
  }
  get basePath(): string {
    return this.#config.basePath;
  }
  /** Gives a cookie-less browser a credential-free ID before it signs in, so that
   * concurrent first sign-ins from its tabs share one lineage. No row is stored;
   * a write never adopts it and moves to a fresh ID. Returns whether it was set.
   */
  bootstrap(request: CookieReader, response: CookieWriter): boolean {
    const cookie = request.get(this.#config.name);
    if (cookie !== undefined && cookie.value !== "") return false;
    try {
      response.set(this.#config.name, newSessionId(), {
        httpOnly: true,
        secure: this.#config.secure,
        sameSite: "lax",
        path: "/",
        maxAge: this.#config.ttl,
      });
    } catch (cause) {
      throw new SessionError("session_store", "Session cookie publication failed", cause);
    }
    return true;
  }
  /** Clears this integration's cookie, e.g. on a proxy redirect for a stale session. */
  expireCookie(cookies: CookieWriter): void {
    try {
      cookies.set(this.#config.name, "", {
        httpOnly: true,
        secure: this.#config.secure,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
    } catch (cause) {
      throw new SessionError("session_store", "Session cookie publication failed", cause);
    }
  }
  #client(
    token: () => string | null,
    alive: () => boolean,
    { readOnly, lifetime }: { readOnly: boolean; lifetime?: AbortSignal | undefined },
  ): NelcotaClient<Database> {
    return requestClient<Database>(
      { api: this.#config.api, options: this.#config.options, redirects: this.#config.redirects },
      { token, alive, readOnly, lifetime },
    );
  }
  #data(client: NelcotaClient<Database>): DataClient<Database> {
    return dataClient(client);
  }
  /**
   * `clearable` (for the proxy) tells whether a stale presented cookie may be deleted: like
   * the write path, a row-less (bootstrap or pre-login) or superseded ID is kept, because the
   * browser may already hold its replacement from a sign-in response still in flight.
   */
  async read<T>(
    cookies: CookieReader,
    work: (context: VerifiedContext<Database>, details: { clearable: boolean }) => Promise<T>,
  ): Promise<T> {
    const identity = await this.#records.readIdentity(cookies.get(this.#config.name)?.value ?? "");
    let alive = true;
    const client = this.#client(
      () => accessToken(identity.state),
      () => alive,
      { readOnly: true },
    );
    try {
      return await work(
        {
          client: this.#data(client),
          hasSession: identity.hasSession,
          staleCookie: identity.staleCookie,
          superseded: identity.superseded,
          getUser: (options) => client.auth.getUser(options),
        },
        {
          clearable: identity.clearable,
        },
      );
    } finally {
      alive = false;
      client.dispose();
    }
  }
  /** Explicit same-origin local reset, usable even when old keys/state are unavailable. */
  async forget(cookies: CookieWriter, request: Request): Promise<void> {
    requireMutation(request.headers, request.method, this.#config.origin);
    const key = await sessionKey(
      cookies.get(this.#config.name)?.value ?? "",
      this.#config.namespace,
    );
    if (key != null && key !== "")
      await this.#config.options.store.exclusive(key, (lease) => lease.remove());
    this.expireCookie(cookies);
  }
  #callbackRequest(request: Request, callback: boolean): boolean {
    // The configured path, host-only cookie, state and PKCE bind callbacks to their browser.
    // Request.url's host can originate in an untrusted Host header.
    const callbackRequest =
      callback &&
      request.method === "GET" &&
      new URL(request.url).pathname === `${this.#config.basePath}/auth/callback`;
    if (callback && callbackRequest === false)
      throw new SessionError("csrf", "Use the configured GET OAuth callback");
    if (callbackRequest === false)
      requireMutation(request.headers, request.method, this.#config.origin);
    return callbackRequest;
  }
  async #initialIdentity(
    cookies: CookieReader,
  ): Promise<{ existingId: string; presented: boolean; id: string; initialKey: string }> {
    const existingId = cookies.get(this.#config.name)?.value ?? "";
    const presented = (await sessionKey(existingId, this.#config.namespace)) !== null;
    const id = presented ? existingId : newSessionId();
    const initialKey = await sessionKey(id, this.#config.namespace);
    if (initialKey === null || initialKey === "")
      throw new SessionError("invalid_session", "Invalid generated session id");
    return { existingId, presented, id, initialKey };
  }
  async write<T>(
    cookies: CookieWriter,
    request: Request,
    ...operation: [work: (context: WritableContext<Database>) => Promise<T>, callback?: boolean]
  ): Promise<T> {
    const [work, callback = false] = operation;
    const callbackRequest = this.#callbackRequest(request, callback);
    const identity = await this.#initialIdentity(cookies);
    const retired = new Set<string>();
    try {
      return await this.#config.options.store.exclusive(identity.initialKey, (lease) =>
        writeSession(this.#records, lease, {
          setup: { ...identity, callbackRequest, cookies, request, retired },
          work,
        }),
      );
    } finally {
      // Retired rows are already dead; remove credentials after releasing the owning lease.
      // oxlint-disable-next-line no-await-in-loop -- Retire each old row only after the current lease has ended.
      for (const key of retired) await this.#records.retire(key).catch(() => undefined);
    }
  }
}
