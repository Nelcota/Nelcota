import type { CookieReader, Integration } from "./context.js";
import { SessionError } from "./errors.js";
import {
  DEFAULT_REFRESH_ENDPOINT,
  DEFAULT_REFRESH_PAGE,
  hasPathControls,
  OAUTH_CALLBACK_PATH,
  safeReturnTo,
} from "./http/policy.js";
const MAX_POLICY_PATHS = 32;
const MAX_PATH_DECODINGS = 3;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

export interface GuardOptions {
  protectedPaths: readonly string[];
  loginPath?: string;
  /** Page the guard sends an expired session to (default `/auth/refresh`). It is a
   * navigation target that POSTs the refresh, distinct from the POST endpoint used by
   * `refreshSession()` (`/auth/session/refresh`); both are always public. */
  refreshPath?: string;
  /** Paths where a cookie-less browser receives a credential-free bootstrap ID, so
   * concurrent first sign-ins from its tabs are ordered. Default: `[loginPath]`. */
  bootstrapPaths?: readonly string[];
}

/** What a framework adapter answers for one request. `allow` and every non-`public`
 * answer carry user-specific state and must be sent with private cache headers. */
export type GuardDecision =
  | { kind: "public" }
  | { kind: "allow" }
  | { kind: "invalid_path" }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "redirect"; location: string; clearCookie: boolean };

/** How the framework adapter routes. */
export interface GuardAdapterOptions {
  /** Write `next` with the app basePath, for frameworks whose redirect helpers do
   * not add it (SvelteKit). Next.js adds basePath itself, so the default is false. */
  nextIncludesBasePath?: boolean;
}

export interface Guard {
  readonly login: string;
  readonly refresh: string;
  /** Whether a cookie-less request to `pathname` should receive a bootstrap ID. */
  bootstraps(pathname: string): boolean;
  /** Authentication routing only. Backend grants/RLS still decide authorization.
   * Never refreshes: an expired session is sent to the explicit POST-owned flow. */
  check<Database>(
    owner: Integration<Database>,
    cookies: CookieReader,
    url: URL,
  ): Promise<GuardDecision>;
}

export function configPath(value: string): string {
  const url = new URL(value, "https://path.invalid");
  if (safeReturnTo(value) !== value || url.search !== "" || url.hash !== "")
    throw new SessionError(
      "configuration",
      "Configure canonical local paths without queries or fragments",
    );
  return value;
}

interface RoutePolicy {
  paths: readonly string[];
  login: string;
  refresh: string;
  excluded: ReadonlySet<string>;
  bootstraps: ReadonlySet<string>;
  ignored: readonly string[];
  nextIncludesBasePath: boolean;
}
function routePolicy(
  policy: GuardOptions,
  ignored: readonly string[],
  adapter: GuardAdapterOptions,
): RoutePolicy {
  if (
    Array.isArray(policy.protectedPaths) === false ||
    policy.protectedPaths.length < 1 ||
    policy.protectedPaths.length > MAX_POLICY_PATHS
  )
    throw new SessionError("configuration", "Configure one to thirty-two protected path prefixes");
  const paths = policy.protectedPaths.map(configPath);
  const login = configPath(policy.loginPath ?? "/login");
  const refresh = configPath(policy.refreshPath ?? DEFAULT_REFRESH_PAGE);
  if (
    policy.bootstrapPaths !== undefined &&
    (Array.isArray(policy.bootstrapPaths) === false ||
      policy.bootstrapPaths.length > MAX_POLICY_PATHS)
  )
    throw new SessionError("configuration", "Configure at most thirty-two bootstrap paths");
  return {
    paths,
    login,
    refresh,
    ignored,
    nextIncludesBasePath: adapter.nextIncludesBasePath === true,
    excluded: new Set([login, refresh, OAUTH_CALLBACK_PATH, DEFAULT_REFRESH_ENDPOINT]),
    bootstraps: new Set((policy.bootstrapPaths ?? [login]).map(configPath)),
  };
}
function guarded(path: string, paths: readonly string[]): boolean {
  return paths.some((prefix) => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`));
}
// Lenient decoding only decides whether strict validation applies; malformed runs remain intact.
function lenient(path: string): string {
  return path.replaceAll(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
function decodeRepeated(path: string, decoder: (value: string) => string): string {
  let decoded = path;
  for (let count = 0; count < MAX_PATH_DECODINGS && decoded.includes("%"); count++)
    decoded = decoder(decoded);
  return decoded;
}
function pathDecision(url: URL, policy: RoutePolicy): GuardDecision | null {
  const loose = decodeRepeated(url.pathname, lenient);
  if (
    guarded(url.pathname, policy.paths) === false &&
    guarded(loose.replaceAll("\\", "/"), policy.paths) === false
  )
    return { kind: "public" };
  let path: string;
  try {
    path = decodeRepeated(url.pathname, decodeURIComponent);
  } catch {
    return { kind: "invalid_path" };
  }
  if (hasPathControls(path) || path.includes("\\") || /%[0-9a-f]{2}/i.test(path))
    return { kind: "invalid_path" };
  if (
    policy.excluded.has(path) ||
    policy.ignored.some((prefix) => path.startsWith(prefix)) ||
    guarded(path, policy.paths) === false
  )
    return { kind: "public" };
  return null;
}
function failureDecision<Database>(
  error: unknown,
  owner: Integration<Database>,
  login: string,
): GuardDecision | null {
  if (error instanceof SessionError && ["session_store", "session_capacity"].includes(error.code))
    return { kind: "unavailable" };
  if (error instanceof SessionError && error.code === "invalid_session")
    return {
      kind: "redirect",
      location: new URL(`${owner.basePath}${login}`, owner.origin).href,
      clearCookie: true,
    };
  return null;
}
async function authenticationDecision<Database>(
  owner: Integration<Database>,
  cookies: CookieReader,
  route: { url: URL; policy: RoutePolicy },
): Promise<GuardDecision> {
  try {
    return await owner.read<GuardDecision>(cookies, async (context, { clearable }) => {
      const user = await context.getUser();
      if (user.error === null) return { kind: "allow" };
      if (user.error.status === HTTP_FORBIDDEN) return { kind: "denied" };
      if (
        user.error.code !== "session_missing" &&
        [HTTP_UNAUTHORIZED, HTTP_NOT_FOUND].includes(user.error.status) === false
      )
        return { kind: "unavailable" };
      const nextPath =
        context.hasSession && user.error.status === HTTP_UNAUTHORIZED
          ? route.policy.refresh
          : route.policy.login;
      const target = new URL(`${owner.basePath}${nextPath}`, owner.origin);
      const base = route.policy.nextIncludesBasePath ? owner.basePath : "";
      target.searchParams.set(
        "next",
        safeReturnTo(`${base}${route.url.pathname}${route.url.search}`),
      );
      // A response still in flight may have replaced a superseded or row-less cookie.
      return { kind: "redirect", location: target.href, clearCookie: clearable };
    });
  } catch (error) {
    const decision = failureDecision(error, owner, route.policy.login);
    if (decision !== null) return decision;
    throw error;
  }
}

/** Validates canonical paths before routing; ignored prefixes belong to framework assets. */
export function createGuard(
  options: GuardOptions,
  ignoredPrefixes: readonly string[],
  adapter: GuardAdapterOptions = {},
): Guard {
  const policy = routePolicy(options, ignoredPrefixes, adapter);
  return {
    login: policy.login,
    refresh: policy.refresh,
    bootstraps: (pathname) => policy.bootstraps.has(pathname),
    check: async (owner, cookies, url) => {
      const decision = pathDecision(url, policy);
      if (decision !== null) return decision;
      return await authenticationDecision(owner, cookies, { url, policy });
    },
  };
}
