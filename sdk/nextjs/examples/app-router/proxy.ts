import type { NextRequest, NextResponse } from 'next/server';
import { createNelcotaProxy } from '@nelcota/nextjs/proxy';
import { options } from './lib/options';

// Redirects signed-out visitors away from /account and gives a cookie-less
// browser a credential-free bootstrap ID on /login, so concurrent sign-ins from
// its tabs are ordered. Authorization still belongs to backend grants/RLS.
let handler: Promise<(request: NextRequest) => Promise<NextResponse>> | undefined;
export async function proxy(request: NextRequest): Promise<NextResponse> {
  handler ??= createNelcotaProxy(options(), { protectedPaths: ['/account'] });
  return (await handler)(request);
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
