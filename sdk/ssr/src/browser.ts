"use client";

import { hasPathControls } from "./http/path.js";
const DEFAULT_REFRESH_TIMEOUT_IN_MS = 10000;
const MAX_REFRESH_TIMEOUT_IN_MS = 30000;

export interface BrowserSessionOptions {
  endpoint?: string;
  timeout?: number;
  signal?: AbortSignal;
}

/** Calls the app's POST refresh route. No access/refresh tokens enter JavaScript.
 * Web Locks reduce duplicate tab requests; the shared server store is the
 * authority when locks are unavailable or requests reach different instances.
 */
export async function refreshSession(options: BrowserSessionOptions = {}): Promise<Response> {
  const endpoint = options.endpoint ?? "/auth/session/refresh";
  const url = refreshUrl(endpoint);
  const timeoutInMs = options.timeout ?? DEFAULT_REFRESH_TIMEOUT_IN_MS;
  if (
    Number.isSafeInteger(timeoutInMs) === false ||
    timeoutInMs < 100 ||
    timeoutInMs > MAX_REFRESH_TIMEOUT_IN_MS
  )
    throw new TypeError("Refresh timeout must be between 100 and 30000 ms");
  const signal = AbortSignal.any([
    ...(options.signal != null ? [options.signal] : []),
    AbortSignal.timeout(timeoutInMs),
  ]);
  const send = async (): Promise<Response> =>
    await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "X-Nelcota-Next": "1" },
      signal,
    });
  const locks = browserLocks();
  if (locks !== undefined)
    return await locks.request(`nelcota-next-refresh:${url.pathname}`, { signal }, send);
  return await send();
}

function refreshUrl(endpoint: string): URL {
  if (
    endpoint.startsWith("/") === false ||
    endpoint.startsWith("//") ||
    hasPathControls(endpoint) ||
    endpoint.includes("\\") ||
    endpoint.includes(" ") ||
    endpoint.includes("#")
  )
    throw new TypeError("Use a same-origin refresh path");
  const url = new URL(endpoint, globalThis.location.origin);
  if (url.origin !== globalThis.location.origin || url.pathname.startsWith("//"))
    throw new TypeError("Use a same-origin refresh path");
  return url;
}

function browserLocks(): LockManager | undefined {
  return (navigator as Partial<Navigator>).locks;
}
