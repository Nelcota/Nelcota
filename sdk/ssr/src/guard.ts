import type { CookieReader, Integration } from './context.js';
import { safeReturnTo } from './policy.js';
import { SessionError } from './errors.js';

export interface GuardOptions {
  protectedPaths: readonly string[];
  loginPath?: string;
  refreshPath?: string;
  /** Paths where a cookie-less browser receives a credential-free bootstrap ID, so
   * concurrent first sign-ins from its tabs are ordered. Default: `[loginPath]`. */
  bootstrapPaths?: readonly string[];
}

/** What a framework adapter answers for one request. `allow` and every non-`public`
 * answer carry user-specific state and must be sent with private cache headers. */
export type GuardDecision =
  | { kind: 'public' }
  | { kind: 'allow' }
  | { kind: 'invalid_path' }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'redirect'; location: string; clearCookie: boolean };

export interface Guard {
  readonly login: string;
  readonly refresh: string;
  /** Whether a cookie-less request to `pathname` should receive a bootstrap ID. */
  bootstraps(pathname: string): boolean;
  /** Authentication routing only. Backend grants/RLS still decide authorization.
   * Never refreshes: an expired session is sent to the explicit POST-owned flow. */
  check<Database>(owner: Integration<Database>, cookies: CookieReader, url: URL): Promise<GuardDecision>;
}

export function configPath(value: string): string {
  const url = new URL(value, 'https://path.invalid');
  if (safeReturnTo(value) !== value || url.search || url.hash) throw new SessionError('configuration', 'Configure canonical local paths without queries or fragments');
  return value;
}

/** Validates the policy up front. `ignoredPrefixes` are the framework's own asset
 * routes (`/_next/`, `/_app/`). */
export function createGuard(policy: GuardOptions, ignoredPrefixes: readonly string[]): Guard {
  if (!Array.isArray(policy.protectedPaths) || policy.protectedPaths.length < 1 || policy.protectedPaths.length > 32) throw new SessionError('configuration', 'Configure one to thirty-two protected path prefixes');
  const paths = policy.protectedPaths.map(configPath);
  const login = configPath(policy.loginPath ?? '/login'), refresh = configPath(policy.refreshPath ?? '/auth/refresh');
  const excluded = new Set([login, refresh, '/auth/callback', '/auth/session/refresh']);
  if (policy.bootstrapPaths !== undefined && (!Array.isArray(policy.bootstrapPaths) || policy.bootstrapPaths.length > 32)) throw new SessionError('configuration', 'Configure at most thirty-two bootstrap paths');
  const bootstraps = new Set((policy.bootstrapPaths ?? [login]).map(configPath));
  const guarded = (path: string): boolean => paths.some(prefix => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`));
  // Lenient decoding keeps undecodable runs; it only decides if strict checks apply.
  const lenient = (path: string): string => path.replace(/(?:%[0-9a-f]{2})+/gi, run => { try { return decodeURIComponent(run); } catch { return run; } });
  return {
    login,
    refresh,
    bootstraps: pathname => bootstraps.has(pathname),
    async check(owner, cookies, url) {
      let path = url.pathname, loose = path;
      for (let count = 0; count < 3 && loose.includes('%'); count++) loose = lenient(loose);
      // Paths that cannot reach a protected prefix pass even with literal `%25`.
      if (!guarded(path) && !guarded(loose.replaceAll('\\', '/'))) return { kind: 'public' };
      try { for (let count = 0; count < 3 && path.includes('%'); count++) path = decodeURIComponent(path); }
      catch { return { kind: 'invalid_path' }; }
      if (/[\\\u0000-\u001f\u007f]/.test(path) || /%[0-9a-f]{2}/i.test(path)) return { kind: 'invalid_path' };
      if (excluded.has(path) || ignoredPrefixes.some(prefix => path.startsWith(prefix)) || !guarded(path)) return { kind: 'public' };
      try {
        return await owner.read<GuardDecision>(cookies, async (context, { clearable }) => {
          const user = await context.getUser();
          if (!user.error) return { kind: 'allow' };
          if (user.error.status === 403) return { kind: 'denied' };
          if (user.error.code !== 'session_missing' && ![401, 404].includes(user.error.status)) return { kind: 'unavailable' };
          const target = new URL(`${owner.basePath}${context.hasSession && user.error.status === 401 ? refresh : login}`, owner.origin);
          target.searchParams.set('next', safeReturnTo(`${url.pathname}${url.search}`));
          // A superseded or row-less cookie may already be replaced by a response in flight
          // (a sign-in rotating a bootstrap ID); leave it.
          return { kind: 'redirect', location: target.href, clearCookie: clearable };
        });
      } catch (error) {
        if (error instanceof SessionError && ['session_store', 'session_capacity'].includes(error.code)) return { kind: 'unavailable' };
        if (error instanceof SessionError && error.code === 'invalid_session') return { kind: 'redirect', location: new URL(`${owner.basePath}${login}`, owner.origin).href, clearCookie: true };
        throw error;
      }
    },
  };
}
