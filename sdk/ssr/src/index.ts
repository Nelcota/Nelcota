// Framework-agnostic, request-scoped Nelcota sessions for server-rendered apps.
// Adapters (Next.js, SvelteKit) supply the cookie jar and the request; tokens stay
// in an encrypted server-side store and the browser only holds an opaque ID.
export { Integration } from './context.js';
export type { SessionOptions, CookieReader, CookieWriter, VerifiedContext, WritableContext, AuthOperations, DataClient, MutationOptions } from './context.js';
export { SessionError, type SessionErrorCode } from './errors.js';
export { safeReturnTo } from './policy.js';
export { createGuard, configPath, type Guard, type GuardOptions, type GuardDecision } from './guard.js';
export type { SessionStore, SessionLease, StoredSession } from './store.js';

/** Responses carrying a session must never be cached or leak the URL as a referrer. */
export function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store, max-age=0');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('pragma', 'no-cache'); headers.set('expires', '0');
  const vary = new Set((headers.get('vary') ?? '').split(',').map(value => value.trim()).filter(value => value !== ''));
  vary.add('Cookie'); headers.set('vary', [...vary].join(', '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
