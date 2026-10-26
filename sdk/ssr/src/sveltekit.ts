// SvelteKit bindings: `handle` for hooks.server.ts, and per-request helpers for
// load functions, form actions and +server.ts endpoints. Structural types keep
// @sveltejs/kit out of the dependencies; a real RequestEvent satisfies them.
import { Integration, type CookieWriter, type SessionOptions, type VerifiedContext, type WritableContext } from './context.js';
import { createGuard, type GuardOptions } from './guard.js';
import { privateResponse } from './private.js';

type CookieOptions = Parameters<CookieWriter['set']>[2];
export interface SvelteKitCookies {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieOptions): void;
}
export interface SvelteKitEvent {
  cookies: SvelteKitCookies;
  request: Request;
  url: URL;
}
// Method syntax keeps `resolve` assignable from Kit's own (RequestEvent) signature.
export interface SvelteKitHandleInput {
  event: SvelteKitEvent;
  resolve(event: SvelteKitEvent): Response | Promise<Response>;
}
export type SvelteKitHandle = (input: SvelteKitHandleInput) => Promise<Response>;

export interface SvelteKitIntegration<Database> {
  /** Load functions: verified identity, never refreshed or rotated while rendering. */
  server<T>(event: SvelteKitEvent, work: (context: VerifiedContext<Database>) => Promise<T>): Promise<T>;
  /** +server.ts endpoints for unsafe same-origin requests (sign-in, refresh, writes). */
  route(event: SvelteKitEvent, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
  /** Form actions; SvelteKit only invokes them by POST. */
  action<T>(event: SvelteKitEvent, work: (context: WritableContext<Database>) => Promise<T>): Promise<T>;
  /** The OAuth callback endpoint (GET with `code` and `state`). */
  callback(event: SvelteKitEvent, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
  forgetLocalSession(event: SvelteKitEvent): Promise<Response>;
  /** Authentication routing for hooks.server.ts. Navigation assistance only:
   * backend grants and RLS still decide authorization. */
  handle(policy: GuardOptions): SvelteKitHandle;
}

const jar = (cookies: SvelteKitCookies): CookieWriter => ({
  get: name => { const value = cookies.get(name); return value === undefined ? undefined : { value }; },
  set: (name, value, options) => cookies.set(name, value, options),
});
const json = (body: unknown, status: number): Response => privateResponse(Response.json(body, { status }));

export async function createNelcotaSvelteKit<Database>(options: SessionOptions): Promise<SvelteKitIntegration<Database>> {
  const owner = await Integration.create<Database>(options);
  // SvelteKit's url.pathname includes `paths.base`; routing policies are written without it.
  const local = (url: URL): URL => {
    const base = owner.basePath;
    if (base === '' || !(url.pathname === base || url.pathname.startsWith(`${base}/`))) return url;
    const stripped = new URL(url.href);
    stripped.pathname = url.pathname.slice(base.length) || '/';
    return stripped;
  };
  return {
    server: (event, work) => owner.read(jar(event.cookies), context => work(context)),
    route: async (event, work) => privateResponse(await owner.write(jar(event.cookies), event.request, work)),
    action: (event, work) => owner.write(jar(event.cookies), event.request, work),
    callback: async (event, work) => privateResponse(await owner.write(jar(event.cookies), event.request, work, true)),
    forgetLocalSession: async event => { await owner.forget(jar(event.cookies), event.request); return privateResponse(new Response(null, { status: 204 })); },
    handle(policy) {
      const guard = createGuard(policy, ['/_app/']);
      return async ({ event, resolve }) => {
        const cookies = jar(event.cookies), url = local(event.url);
        const decision = await guard.check(owner, cookies, url);
        let response: Response;
        switch (decision.kind) {
          case 'public': response = await resolve(event); break;
          case 'allow': response = privateResponse(await resolve(event)); break;
          case 'invalid_path': return json({ error: 'invalid_path' }, 400);
          case 'denied': return json({ error: 'access_denied' }, 403);
          case 'unavailable': return json({ error: 'auth_service_unavailable' }, 503);
          case 'redirect':
            if (decision.clearCookie) owner.expireCookie(cookies);
            return privateResponse(new Response(null, { status: 303, headers: { location: decision.location } }));
        }
        // SvelteKit applies cookies set through event.cookies to this response.
        if (guard.bootstraps(url.pathname) && owner.bootstrap(cookies, cookies)) return privateResponse(response);
        return response;
      };
    },
  };
}
