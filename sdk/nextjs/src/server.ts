import 'server-only';
import { cookies, headers } from 'next/headers.js';
import { Integration, privateResponse, type SessionOptions, type VerifiedContext, type WritableContext } from '@nelcota/ssr';
export { SessionError, safeReturnTo } from '@nelcota/ssr';
export type { SessionStore, SessionLease, StoredSession, VerifiedContext, WritableContext, AuthOperations, DataClient } from '@nelcota/ssr';
export type NextOptions = SessionOptions;

export interface NextIntegration<Database> {
  server<T>(work: (context: VerifiedContext<Database>) => Promise<T>): Promise<T>;
  route(request: Request, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
  forgetLocalSession(request: Request): Promise<Response>;
  action<T>(work: (context: WritableContext<Database>) => Promise<T>): Promise<T>;
  callback(request: Request, work: (context: WritableContext<Database>) => Promise<Response>): Promise<Response>;
}
export async function createNelcotaNext<Database>(options: NextOptions): Promise<NextIntegration<Database>> {
  const owner = await Integration.create<Database>(options);
  return {
    server: async work => owner.read(await cookies(), context => work(context)),
    route: async (request, work) => privateResponse(await owner.write(await cookies(), request, work)),
    forgetLocalSession: async request => { await owner.forget(await cookies(), request); return privateResponse(new Response(null, { status: 204 })); },
    // Next only invokes Server Actions by POST, so the method is fixed here; CSRF
    // protection comes from the exact Origin check plus Next's own action checks.
    action: async work => owner.write(await cookies(), new Request(owner.origin, { method: 'POST', headers: new Headers(await headers()) }), work),
    callback: async (request, work) => privateResponse(await owner.write(await cookies(), request, work, true)),
  };
}
