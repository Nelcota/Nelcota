import "server-only";
import { Integration, createGuard, type GuardOptions, type SessionOptions } from "@nelcota/ssr";
import { NextResponse, type NextRequest } from "next/server.js";
const HTTP_SEE_OTHER = 303;

export type ProxyOptions = GuardOptions;
function privateHeaders(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
/** Authentication routing only. Backend grants/RLS still decide authorization.
 * Never refresh from proxy: route the browser to an explicit POST-owned flow.
 */
export async function createNelcotaProxy(
  options: SessionOptions,
  policy: ProxyOptions,
): Promise<(request: NextRequest) => Promise<NextResponse>> {
  const guard = createGuard(policy, ["/_next/"]);
  const owner = await Integration.create(options);
  return async (request) => {
    const response = await handle(request);
    if (
      guard.bootstraps(request.nextUrl.pathname) &&
      owner.bootstrap(request.cookies, response.cookies)
    )
      return privateHeaders(response);
    return response;
  };
  async function handle(request: NextRequest): Promise<NextResponse> {
    const decision = await guard.check(owner, request.cookies, request.nextUrl);
    switch (decision.kind) {
      case "public":
        return NextResponse.next();
      case "allow":
        return privateHeaders(NextResponse.next());
      case "invalid_path":
        return privateHeaders(NextResponse.json({ error: "invalid_path" }, { status: 400 }));
      case "denied":
        return privateHeaders(NextResponse.json({ error: "access_denied" }, { status: 403 }));
      case "unavailable":
        return privateHeaders(
          NextResponse.json({ error: "auth_service_unavailable" }, { status: 503 }),
        );
      case "redirect": {
        const response = NextResponse.redirect(decision.location, HTTP_SEE_OTHER);
        if (decision.clearCookie) owner.expireCookie(response.cookies);
        return privateHeaders(response);
      }
    }
  }
}
