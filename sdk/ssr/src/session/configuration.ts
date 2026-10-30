import { SessionError } from "../errors.js";
import { trustedUrl } from "../http/policy.js";
import type { SessionOptions } from "./types.js";

export interface SessionConfiguration {
  options: Omit<SessionOptions, "keys">;
  api: URL;
  origin: string;
  secure: boolean;
  basePath: string;
  namespace: string;
  name: string;
  ttl: number;
  redirects: ReadonlySet<string>;
}

export function sessionConfiguration(options: SessionOptions, scope: string): SessionConfiguration {
  const { keys: _keys, ...settings } = options;
  const development = options.allowInsecureDevelopment === true;
  const api = trustedUrl(options.url, development);
  const app = applicationUrl(options.appOrigin, development);
  const secure = app.protocol === "https:";
  const basePath = checkedBasePath(options.basePath ?? "");
  // Frozen: default cookie names are wire format; changing them signs everyone out.
  const name = cookieName(
    options.cookieName ?? `${secure ? "__Host-nelcota" : "nelcota-dev"}-${scope}`,
    secure,
  );
  const ttl = sessionTtl(options.sessionTtlSeconds ?? SESSION_LIMITS.defaultTtlSeconds);
  requireRequestTimeout(options.timeout ?? SESSION_LIMITS.requestTimeoutInMs);
  if (options.store.durability !== "shared" && development === false)
    throw new SessionError(
      "configuration",
      "Production requires an authoritative shared session store",
    );
  const redirects = redirectOrigins(options.storageRedirectOrigins ?? [], development);
  return {
    options: settings,
    api,
    origin: app.origin,
    secure,
    basePath,
    namespace: `${app.origin}\0${api.href}`,
    name,
    ttl,
    redirects,
  };
}
function applicationUrl(value: string, development: boolean): URL {
  const app = trustedUrl(value, development, true);
  if (development && ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname) === false)
    throw new SessionError(
      "configuration",
      "Insecure development requires a loopback application origin",
    );
  return app;
}
function checkedBasePath(value: string): string {
  if (value !== "" && /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/.test(value) === false)
    throw new SessionError(
      "configuration",
      "basePath must be empty or a canonical path such as /app",
    );
  return value;
}
function cookieName(name: string, secure: boolean): string {
  if (
    /^[A-Za-z0-9_-]{1,64}$/.test(name) === false ||
    (secure && name.startsWith("__Host-") === false) ||
    (secure === false && name.startsWith("__Host-"))
  )
    throw new SessionError("configuration", "Invalid host-only session cookie name");
  return name;
}
function sessionTtl(ttl: number): number {
  if (
    Number.isSafeInteger(ttl) === false ||
    ttl < SESSION_LIMITS.minimumTtlSeconds ||
    ttl > SESSION_LIMITS.maximumTtlSeconds
  )
    throw new SessionError(
      "configuration",
      "Session TTL must be between five minutes and thirty days",
    );
  return ttl;
}
function requireRequestTimeout(timeoutInMs: number): void {
  if (
    Number.isSafeInteger(timeoutInMs) === false ||
    timeoutInMs < 100 ||
    timeoutInMs > SESSION_LIMITS.requestTimeoutInMs
  )
    throw new SessionError("configuration", "Request timeout must be between 100 and 30000 ms");
}
function redirectOrigins(origins: readonly string[], development: boolean): ReadonlySet<string> {
  if (Array.isArray(origins) === false || origins.length > SESSION_LIMITS.redirectOrigins)
    throw new SessionError(
      "configuration",
      "storageRedirectOrigins must be an array of at most sixteen origins",
    );
  return new Set(
    origins.map((origin) => {
      if (typeof origin !== "string")
        throw new SessionError(
          "configuration",
          "storageRedirectOrigins must contain origin strings",
        );
      return trustedUrl(origin, development, true).origin;
    }),
  );
}

export const SESSION_LIMITS = {
  requestTimeoutInMs: 30_000,
  tokenChars: 16_384,
  defaultTtlSeconds: 604_800, // Seven days.
  minimumTtlSeconds: 300,
  maximumTtlSeconds: 2_592_000, // Thirty days.
  redirectOrigins: 16,
  scopeDigestChars: 12,
  queuedActions: 32,
} as const;
