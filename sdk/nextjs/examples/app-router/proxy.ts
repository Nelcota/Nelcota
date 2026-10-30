import { createNelcotaProxy } from "@nelcota/nextjs/proxy";
import type { NextRequest, NextResponse } from "next/server";

import { options } from "./lib/options";

// Redirects signed-out visitors away from /account and gives a cookie-less
// browser a credential-free bootstrap ID on /login, so concurrent sign-ins from
// its tabs are ordered. Authorization still belongs to backend grants/RLS.
// /profile is deliberately left unguarded: it shows how a Server Component handles
// a signed-out visitor itself, which every page must do even behind the proxy.
let handler: Promise<(request: NextRequest) => Promise<NextResponse>> | undefined;
export async function proxy(request: NextRequest): Promise<NextResponse> {
  // A rejected setup is dropped, so the next request retries it.
  handler ??= options()
    .then(async (selected) => await createNelcotaProxy(selected, { protectedPaths: ["/account"] }))
    .catch((error: unknown) => {
      handler = undefined;
      throw error;
    });
  return await (
    await handler
  )(request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
