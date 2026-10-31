import { SessionError } from "../errors.js";
const ASCII_CONTROL_END = 31;
const ASCII_DELETE = 127;
const MAX_RETURN_PATH_CHARS = 2048;
const MAX_PATH_DECODINGS = 3;

/** ASCII path controls must be rejected before any URL normalization. */
export function hasPathControls(value: string): boolean {
  return Array.from(value).some(
    (char) => char.charCodeAt(0) <= ASCII_CONTROL_END || char.charCodeAt(0) === ASCII_DELETE,
  );
}

/** Default guard target for an expired access token: a page that POSTs a refresh
 * (`auth.refresh()`) and returns to `next`. */
export const DEFAULT_REFRESH_PAGE = "/auth/refresh";
/** Default POST endpoint that `refreshSession()` from `@nelcota/ssr/browser` calls. */
export const DEFAULT_REFRESH_ENDPOINT = "/auth/session/refresh";
/** OAuth callback path, relative to the configured basePath. */
export const OAUTH_CALLBACK_PATH = "/auth/callback";

export function trustedUrl(value: string, development: boolean, originOnly = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SessionError("configuration", "Invalid application or API URL");
  }
  if (
    protocolAllowed(url, development) === false ||
    url.username !== "" ||
    url.password !== "" ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    (originOnly && url.pathname !== "/")
  ) {
    throw new SessionError(
      "configuration",
      "Use HTTPS URLs without credentials, queries or fragments; insecure development is loopback-only",
    );
  }
  return url;
}

function protocolAllowed(url: URL, development: boolean): boolean {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || (development && local && url.protocol === "http:");
}
function canonicalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path.startsWith("//") === false &&
    hasPathControls(path) === false &&
    path.includes("\\") === false
  );
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Only local, canonical paths. Never reflect an untrusted absolute redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_RETURN_PATH_CHARS) return "/";
  let decoded = value;
  for (let count = 0; count < MAX_PATH_DECODINGS; count++) {
    if (canonicalPath(decoded) === false) return "/";
    const next = decodePath(decoded);
    if (next === null) return "/";
    if (next === decoded) break;
    decoded = next;
  }
  // Reject residual encodings rather than leaving a fourth decoder a redirect.
  if (/%[0-9a-f]{2}/i.test(decoded)) return "/";
  const url = new URL(value, "https://return.invalid");
  if (url.origin !== "https://return.invalid" || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function requireMutation(
  headers: Pick<Headers, "get">,
  method: string,
  origin: string,
): void {
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) === false ||
    headers.get("origin") !== origin ||
    headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new SessionError("csrf", "This operation requires a same-origin unsafe request");
  }
}
