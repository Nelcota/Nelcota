/**
 * Reading (never verifying) JWT payloads. The server verifies every token;
 * the client only looks at `role` and `exp` to refuse obvious mistakes and to
 * schedule refreshes.
 */

import { NelcotaUsageError } from "./client.errors.js";
import { isBrowser, isWorkerScope } from "./runtime.js";
const JWT_SEGMENT_COUNT = 3;

function base64UrlDecode(text: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
  );
}

export interface JwtPayload {
  role?: unknown;
  exp?: unknown;
  sub?: unknown;
  [claim: string]: unknown;
}

/** The payload of a JWT, or `null` when the text is not one. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== JWT_SEGMENT_COUNT || parts[1] === undefined || parts[1] === "") return null;
  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]));
    return typeof payload === "object" && payload !== null && Array.isArray(payload) === false
      ? (payload as JwtPayload)
      : null;
  } catch {
    return null;
  }
}

let lastChecked: string | undefined;

/**
 * Refuses a `service_role` token in a browser: it bypasses RLS, so anyone who
 * opens the page could read and change every row. It belongs on a server.
 */
export function assertTokenAllowed(token: string, browser: boolean = isBrowser()): void {
  if (token === lastChecked || (browser || isWorkerScope()) === false) return;
  if (decodeJwt(token)?.role === "service_role") {
    throw new NelcotaUsageError(
      "A service_role token bypasses RLS and must never reach a browser. Use it only on a server.",
    );
  }
  lastChecked = token;
}
