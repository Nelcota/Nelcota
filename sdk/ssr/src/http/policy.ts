import { SessionError } from "../errors.js";
import { hasPathControls } from "./path.js";
const MAX_RETURN_PATH_CHARS = 2048;
const MAX_PATH_DECODINGS = 3;

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
