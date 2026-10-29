import { NelcotaError, type FetchLike } from "@nelcota/client";

import { isRedirect } from "./status.js";

interface RedirectPolicy {
  api: URL;
  origins: ReadonlySet<string>;
  development: boolean;
}
const MAX_STORAGE_HOPS = 3;
const HOP_HEADERS = [
  "accept",
  "range",
  "if-none-match",
  "if-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
];
function refused(
  code: "storage_redirect_refused" | "storage_redirect_limit",
  message: string,
): NelcotaError {
  return new NelcotaError({ status: 0, code, message });
}
function allowedTransport(url: URL, development: boolean): boolean {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || (url.protocol === "http:" && local && development);
}
function destination(location: string | null, target: URL, policy: RedirectPolicy): URL {
  let next: URL;
  try {
    next = new URL(location ?? "", target);
  } catch {
    throw refused("storage_redirect_refused", "Invalid storage redirect location");
  }
  if (
    location == null ||
    location === "" ||
    allowedTransport(next, policy.development) === false ||
    next.username !== "" ||
    next.password !== "" ||
    policy.origins.has(next.origin) === false
  )
    throw refused("storage_redirect_refused", "Storage redirect destination is not allowed");
  return next;
}

/** Follows only approved storage redirects, dropping credentials permanently on the first foreign hop. */
export async function followStorage(
  send: FetchLike,
  url: URL,
  { init, policy }: { init: RequestInit; policy: RedirectPolicy },
): Promise<Response> {
  let target = url,
    headers = new Headers(init.headers),
    credentialed = true;
  for (let hop = 0; ; hop++) {
    // oxlint-disable-next-line no-await-in-loop -- Each redirect target and credential policy depend on the preceding response.
    const response = await send(target.href, { ...init, headers, redirect: "manual" });
    if (isRedirect(response.status) === false) return response;
    const location = response.headers.get("location");
    void response.body?.cancel().catch(() => undefined);
    if (policy.origins.size === 0)
      throw refused(
        "storage_redirect_refused",
        "Storage redirects require an explicit storageRedirectOrigins policy",
      );
    if (hop >= MAX_STORAGE_HOPS)
      throw refused("storage_redirect_limit", "Too many storage redirects");
    const next = destination(location, target, policy);
    if (next.origin !== policy.api.origin) credentialed = false;
    if (credentialed === false)
      headers = new Headers(
        HOP_HEADERS.flatMap((name) => {
          const value = headers.get(name);
          return value === null ? [] : [[name, value] as [string, string]];
        }),
      );
    target = next;
  }
}
