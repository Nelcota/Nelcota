import 'server-only';
import { NextResponse, type NextRequest } from 'next/server.js';
import { Integration, type NextOptions } from './context.js';
import { safeReturnTo } from './policy.js';
import { SessionError } from './errors.js';

export interface ProxyOptions {
  protectedPaths: readonly string[];
  loginPath?: string;
  refreshPath?: string;
}
function configPath(value: string): string {
  const url = new URL(value, 'https://path.invalid');
  if (safeReturnTo(value) !== value || url.search || url.hash) throw new SessionError('configuration', 'Configure canonical local paths without queries or fragments');
  return value;
}
function privateHeaders(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'private, no-store, max-age=0');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
/** Authentication routing only. Backend grants/RLS still decide authorization.
 * Never refresh from proxy: route the browser to an explicit POST-owned flow.
 */
export async function createNelcotaProxy(options: NextOptions, policy: ProxyOptions): Promise<(request: NextRequest) => Promise<NextResponse>> {
  if (!Array.isArray(policy.protectedPaths) || policy.protectedPaths.length < 1 || policy.protectedPaths.length > 32) throw new SessionError('configuration', 'Configure one to thirty-two protected path prefixes');
  const owner = await Integration.create(options);
  const paths = policy.protectedPaths.map(configPath);
  const login = configPath(policy.loginPath ?? '/login'), refresh = configPath(policy.refreshPath ?? '/auth/refresh');
  const excluded = new Set([login, refresh, '/auth/callback', '/auth/session/refresh']);
  return async request => {
    let path = request.nextUrl.pathname;
    try { for (let count = 0; count < 3 && path.includes('%'); count++) path = decodeURIComponent(path); }
    catch { return privateHeaders(NextResponse.json({ error: 'invalid_path' }, { status: 400 })); }
    if (/[\\\u0000-\u001f\u007f]/.test(path) || /%[0-9a-f]{2}/i.test(path)) return privateHeaders(NextResponse.json({ error: 'invalid_path' }, { status: 400 }));
    if (excluded.has(path) || path.startsWith('/_next/') || !paths.some(prefix => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`))) return NextResponse.next();
    try {
      return await owner.read(request.cookies, async context => {
        const user = await context.getUser();
        if (!user.error) return privateHeaders(NextResponse.next());
        if (user.error.status === 403) return privateHeaders(NextResponse.json({ error: 'access_denied' }, { status: 403 }));
        if (user.error.code !== 'session_missing' && ![401, 404].includes(user.error.status)) return privateHeaders(NextResponse.json({ error: 'auth_service_unavailable' }, { status: 503 }));
        const target = new URL(context.hasSession && user.error.status === 401 ? refresh : login, owner.origin);
        target.searchParams.set('next', safeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`));
        const response = NextResponse.redirect(target, 303);
        if (context.staleCookie) owner.expireCookie(response.cookies);
        return privateHeaders(response);
      });
    } catch (error) {
      if (error instanceof SessionError && error.code === 'invalid_session') { const response = NextResponse.redirect(new URL(login, owner.origin), 303); owner.expireCookie(response.cookies); return privateHeaders(response); }
      throw error;
    }
  };
}
