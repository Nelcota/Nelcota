import { NelcotaError, NelcotaUsageError, clientError } from "../core/client.errors.js";
import { isBrowser } from "../core/environment.js";
import type { EmailLink, EmailLinkType } from "./types.js";

const MAX_EMAIL_TOKEN_LENGTH = 128;
const LINK_TYPES = new Set<string>(["recovery", "signup", "magiclink"]);
type OAuthRedirect =
  | { kind: "none" }
  | { kind: "error"; error: NelcotaError }
  | { kind: "code"; code: string };

/** Codes the server's OAuth callback redirects with; anything else becomes `oauth_error`. */
const OAUTH_ERROR_CODES = new Set<string>([
  "access_denied",
  "provider_error",
  "provider_disabled",
  "email_required",
  "email_conflict",
  "signup_disabled",
  "invalid_state",
]);
const MAX_RAW_OAUTH_ERROR_CHARS = 64;

/** Reads `?code=` or `?error=` without changing the address bar (see `clearOAuthRedirect`). */
export function readOAuthRedirect(href: string): OAuthRedirect {
  if (href === "") return { kind: "none" };
  const url = absoluteUrl(href, "URL");
  const code = url.searchParams.get("code"),
    error = url.searchParams.get("error");
  if (code === null && error === null) return { kind: "none" };
  if (error !== null) return { kind: "error", error: oauthError(error.trim()) };
  if (code === null || code.trim() === "")
    return { kind: "error", error: clientError("invalid_response", "Missing OAuth code") };
  return { kind: "code", code };
}

/** Removes `code` and `error` from the address bar and history once the redirect is handled. */
export function clearOAuthRedirect(href: string): void {
  const url = absoluteUrl(href, "URL");
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  replaceUrl(href, url);
}

/**
 * A URL parameter is attacker-controlled: only a known code becomes
 * `NelcotaError.code`. Any other value is `oauth_error`, with a truncated,
 * character-restricted copy in `details`.
 */
function oauthError(raw: string): NelcotaError {
  if (raw === "")
    return new NelcotaError({ status: 0, code: "provider_error", message: "Sign-in failed" });
  if (OAUTH_ERROR_CODES.has(raw))
    return new NelcotaError({ status: 0, code: raw, message: "Sign-in failed" });
  return new NelcotaError({
    status: 0,
    code: "oauth_error",
    message: "Sign-in failed",
    details: raw.replaceAll(/[^\w.-]/g, "_").slice(0, MAX_RAW_OAUTH_ERROR_CHARS),
  });
}

export function parseEmailLink(href: string): EmailLink | null {
  if (href === "") return null;
  const url = absoluteUrl(href, "URL");
  const params = new URLSearchParams(url.hash.slice(1));
  const type = params.get("type");
  const token = params.get("token");
  if (
    type === null ||
    token === null ||
    LINK_TYPES.has(type) === false ||
    token.length === 0 ||
    token.length > MAX_EMAIL_TOKEN_LENGTH
  ) {
    return null;
  }
  url.hash = "";
  replaceUrl(href, url);
  return { type: type as EmailLinkType, token };
}

export function absoluteUrl(value: string, what: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new NelcotaUsageError(`${what} must be an absolute URL`);
  }
}

function replaceUrl(original: string, url: URL): void {
  if (isBrowser() === false || (globalThis as { location?: Location }).location?.href !== original)
    return;
  try {
    globalThis.history.replaceState(globalThis.history.state, "", url.href);
  } catch {
    // A different origin or a sandboxed frame: nothing to clean.
  }
}
