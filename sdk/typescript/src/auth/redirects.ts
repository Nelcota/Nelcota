import { NelcotaError, NelcotaUsageError, clientError } from "../core/client.errors.js";
import { isBrowser } from "../core/jwt.js";
import type { EmailLink, EmailLinkType } from "./types.js";

const MAX_EMAIL_TOKEN_LENGTH = 128;
const LINK_TYPES = new Set<string>(["recovery", "signup", "magiclink"]);
type OAuthRedirect =
  | { kind: "none" }
  | { kind: "error"; error: NelcotaError }
  | { kind: "code"; code: string };

export function readOAuthRedirect(href: string): OAuthRedirect {
  if (href === "") return { kind: "none" };
  const url = absoluteUrl(href, "URL");
  const code = url.searchParams.get("code"),
    error = url.searchParams.get("error");
  if (code === null && error === null) return { kind: "none" };
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  replaceUrl(href, url);
  if (error !== null)
    return {
      kind: "error",
      error: new NelcotaError({
        status: 0,
        code: error.trim() === "" ? "provider_error" : error.trim(),
        message: "Sign-in failed",
      }),
    };
  if (code === null || code.trim() === "")
    return { kind: "error", error: clientError("invalid_response", "Missing OAuth code") };
  return { kind: "code", code };
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
