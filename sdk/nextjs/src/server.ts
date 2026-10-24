import 'server-only';
import { cookies, headers } from 'next/headers.js';
import { Integration, type NextOptions, type VerifiedContext, type WritableContext } from './context.js';
export { SessionError } from './errors.js';
export { safeReturnTo } from './policy.js';
export type { SessionStore, SessionLease, StoredSession } from './store.js';
export type { NextOptions, VerifiedContext, WritableContext, AuthOperations, DataClient } from './context.js';

export interface NextIntegration<Database> {
  server<T>(work: (context: VerifiedContext<Database>) => Promise<T>): Promise<T>;
  route(request: Request, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
  forgetLocalSession(request: Request): Promise<Response>;
  action<T>(work: (context: WritableContext<Database>) => Promise<T>): Promise<T>;
  callback(request: Request, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
}
function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store, max-age=0');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('pragma', 'no-cache'); headers.set('expires', '0');
  const vary = new Set((headers.get('vary') ?? '').split(',').map(value => value.trim()).filter(value => value !== ''));
  vary.add('Cookie'); headers.set('vary', [...vary].join(', '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export async function createNelcotaNext<Database>(options: NextOptions): Promise<NextIntegration<Database>> {
  const owner = await Integration.create<Database>(options);
  return {
    server: async work => owner.read(await cookies(), work),
    route: async (request, work) => privateResponse(await owner.write(await cookies(), request, work)),
    forgetLocalSession: async request => { await owner.forget(await cookies(), request); return privateResponse(new Response(null, { status: 204 })); },
    // Next only invokes Server Actions by POST, so the method is fixed here; CSRF
    // protection comes from the exact Origin check plus Next's own action checks.
    action: async work => owner.write(await cookies(), new Request(owner.origin, { method: 'POST', headers: new Headers(await headers()) }), work),
    callback: async (request, work) => privateResponse(await owner.write(await cookies(), request, work, true)),
  };
}
