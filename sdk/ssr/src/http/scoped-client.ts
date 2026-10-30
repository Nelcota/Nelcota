import { createClient, NelcotaError, type FetchLike, type NelcotaClient } from "@nelcota/client";

import { SessionError } from "../errors.js";
import { SESSION_LIMITS } from "../session/configuration.js";
import type { DataClient, SessionOptions } from "../session/types.js";
import { followStorage } from "./storage-redirect.js";

interface ClientOwner {
  api: URL;
  options: Pick<SessionOptions, "fetch" | "timeout" | "allowInsecureDevelopment">;
  redirects: ReadonlySet<string>;
}
interface ClientScope {
  token: () => string | null;
  alive: () => boolean;
  readOnly: boolean;
  lifetime?: AbortSignal | undefined;
}

export function requestClient<Database>(
  owner: ClientOwner,
  scope: ClientScope,
): NelcotaClient<Database> {
  const send = owner.options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = owner.options.timeout ?? SESSION_LIMITS.requestTimeoutInMs;
  return createClient<Database>(owner.api.href, {
    accessToken: () => {
      requireAlive(scope);
      return scope.token();
    },
    timeout,
    retries: 0,
    auth: { autoRefresh: false },
    fetch: scopedFetch(owner, scope, send),
  });
}
function requireAlive(scope: ClientScope): void {
  if (scope.alive() === false)
    throw new SessionError("closed_context", "The request context has ended");
}
function requestUrl(input: Parameters<FetchLike>[0], owner: ClientOwner): URL {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== owner.api.origin)
    throw new SessionError("configuration", "Request escaped the configured API origin");
  return url;
}
function storageObject(api: URL, url: URL, method: string): boolean {
  const prefix = `${api.pathname.replace(/\/$/, "")}/storage/v1/object/`;
  return (method === "GET" || method === "HEAD") && url.pathname.startsWith(prefix);
}
function scopedFetch(owner: ClientOwner, scope: ClientScope, send: FetchLike): FetchLike {
  return async (input, init = {}) => {
    requireAlive(scope);
    const method = init.method ?? "GET";
    if (scope.readOnly && ["GET", "HEAD"].includes(method) === false)
      throw new NelcotaError({
        status: 0,
        code: "read_only",
        message: "This read-only session context cannot mutate data or session state",
      });
    const url = requestUrl(input, owner);
    const headers = headerLifetime(
      init.signal ?? undefined,
      scope.lifetime,
      owner.options.timeout ?? SESSION_LIMITS.requestTimeoutInMs,
    );
    try {
      if (storageObject(owner.api, url, method))
        return await followStorage(send, url, {
          init: { ...init, signal: headers.signal, cache: "no-store" },
          policy: {
            api: owner.api,
            origins: owner.redirects,
            development: owner.options.allowInsecureDevelopment === true,
          },
        });
      return await send(input, {
        ...init,
        signal: headers.signal,
        cache: "no-store",
        redirect: "error",
      });
    } finally {
      headers.release();
    }
  };
}
function headerLifetime(
  requested: AbortSignal | undefined,
  lifetime: AbortSignal | undefined,
  timeoutInMs: number,
): { signal: AbortSignal; release: () => void } {
  const ownership = new AbortController(),
    deadline = new AbortController();
  const lost = (): void => ownership.abort();
  lifetime?.addEventListener("abort", lost, { once: true });
  if (lifetime?.aborted === true) lost();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Header deadline exceeded", "TimeoutError")),
    timeoutInMs,
  );
  const signal = AbortSignal.any([
    ...(requested != null ? [requested] : []),
    ownership.signal,
    deadline.signal,
  ]);
  return {
    signal,
    release: () => {
      // Accepted response streams belong to the consumer after headers arrive.
      clearTimeout(timer);
      lifetime?.removeEventListener("abort", lost);
    },
  };
}

export function dataClient<Database>(client: NelcotaClient<Database>): DataClient<Database> {
  return {
    from: client.from.bind(client),
    rpc: client.rpc.bind(client),
    storage: client.storage,
    url: client.url,
  };
}
