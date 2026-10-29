// SvelteKit bindings: `handle` for hooks.server.ts, and per-request helpers for
// load functions, form actions and +server.ts endpoints. Structural types keep
// @sveltejs/kit out of the dependencies; a real RequestEvent satisfies them.
import {
  Integration,
  type CookieWriter,
  type SessionOptions,
  type VerifiedContext,
  type WritableContext,
} from "./context.js";
import { createGuard, type GuardOptions, type GuardDecision } from "./guard.js";
import { privateResponse } from "./http/private.js";
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

type CookieOptions = Parameters<CookieWriter["set"]>[2];
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
  resolve(this: void, event: SvelteKitEvent): Response | Promise<Response>;
}
export type SvelteKitHandle = (input: SvelteKitHandleInput) => Promise<Response>;

export interface SvelteKitIntegration<Database> {
  /** Load functions: verified identity, never refreshed or rotated while rendering. */
  server<T>(
    event: SvelteKitEvent,
    work: (context: VerifiedContext<Database>) => Promise<T>,
  ): Promise<T>;
  /** +server.ts endpoints for unsafe same-origin requests (sign-in, refresh, writes). */
  route(
    event: SvelteKitEvent,
    work: (context: WritableContext<Database>) => Promise<Response>,
  ): Promise<Response>;
  /** Form actions; SvelteKit only invokes them by POST. */
  action<T>(
    event: SvelteKitEvent,
    work: (context: WritableContext<Database>) => Promise<T>,
  ): Promise<T>;
  /** The OAuth callback endpoint (GET with `code` and `state`). */
  callback(
    event: SvelteKitEvent,
    work: (context: WritableContext<Database>) => Promise<Response>,
  ): Promise<Response>;
  forgetLocalSession(event: SvelteKitEvent): Promise<Response>;
  /** Authentication routing for hooks.server.ts. Navigation assistance only:
   * backend grants and RLS still decide authorization. */
  handle(policy: GuardOptions): SvelteKitHandle;
}

const jar = (cookies: SvelteKitCookies): CookieWriter => ({
  get: (name) => {
    const value = cookies.get(name);
    return value === undefined ? undefined : { value };
  },
  set: (name, value, options) => cookies.set(name, value, options),
});
function setCookie(name: string, value: string, options: CookieOptions): string {
  return `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
}
const json = (body: unknown, status: number): Response =>
  privateResponse(Response.json(body, { status }));
// Pages keep the URL from other sites but not from the app itself: under `no-referrer`
// Chromium sends `Origin: null` with a native form POST, which every CSRF check refuses.
const privatePage = (response: Response): Response => {
  const page = privateResponse(response);
  page.headers.set("referrer-policy", "same-origin");
  return page;
};

// Kit decodes the base path with decodeURI while retaining encoded percent signs.
function localUrl(url: URL, base: string): URL {
  if (base === "") return url;
  let decoded: string;
  try {
    decoded = url.pathname.split("%25").map(decodeURI).join("%25");
  } catch {
    return url;
  }
  if ((decoded === base || decoded.startsWith(`${base}/`)) === false) return url;
  const stripped = new URL(url.href);
  const path = decoded.slice(base.length);
  stripped.pathname = path === "" ? "/" : path;
  return stripped;
}

function decisionResponse<Database>(
  owner: Integration<Database>,
  decision: GuardDecision,
): Response | null {
  switch (decision.kind) {
    case "invalid_path":
      return json({ error: "invalid_path" }, HTTP_BAD_REQUEST);
    case "denied":
      return json({ error: "access_denied" }, HTTP_FORBIDDEN);
    case "unavailable":
      return json({ error: "auth_service_unavailable" }, HTTP_UNAVAILABLE);
    case "redirect": {
      // Kit applies event.cookies to resolve responses; hook-owned responses publish their own cookies.
      const headers = new Headers({ location: decision.location });
      if (decision.clearCookie)
        owner.expireCookie({
          get: () => undefined,
          set: (name, value, options) =>
            headers.append("set-cookie", setCookie(name, value, options)),
        });
      return privateResponse(new Response(null, { status: 303, headers }));
    }
    case "allow":
    case "public":
      return null;
  }
}

function frameworkHandle<Database>(
  owner: Integration<Database>,
  policy: GuardOptions,
): SvelteKitHandle {
  const guard = createGuard(policy, ["/_app/"]);
  return async ({ event, resolve }) => {
    const cookies = jar(event.cookies);
    const url = localUrl(event.url, owner.basePath);
    const decision = await guard.check(owner, cookies, url);
    const answer = decisionResponse(owner, decision);
    if (answer !== null) return answer;
    // Kit refuses cookies after resolve, so publish the bootstrap ID first.
    const bootstrapped = guard.bootstraps(url.pathname) && owner.bootstrap(cookies, cookies);
    const response = await resolve(event);
    return decision.kind === "allow" || bootstrapped ? privatePage(response) : response;
  };
}

export async function createNelcotaSvelteKit<Database = unknown>(
  options: SessionOptions,
): Promise<SvelteKitIntegration<Database>> {
  const owner = await Integration.create<Database>(options);
  return {
    server: (event, work) => owner.read(jar(event.cookies), (context) => work(context)),
    route: async (event, work) =>
      privateResponse(await owner.write(jar(event.cookies), event.request, work)),
    action: (event, work) => owner.write(jar(event.cookies), event.request, work),
    callback: async (event, work) =>
      privateResponse(await owner.write(jar(event.cookies), event.request, work, true)),
    forgetLocalSession: async (event) => {
      await owner.forget(jar(event.cookies), event.request);
      return privateResponse(new Response(null, { status: 204 }));
    },
    handle: (policy) => frameworkHandle(owner, policy),
  };
}
