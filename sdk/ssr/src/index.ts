// Framework-agnostic, request-scoped Nelcota sessions for server-rendered apps.
// Adapters (Next.js, SvelteKit) supply the cookie jar and the request; tokens stay
// in an encrypted server-side store and the browser only holds an opaque ID.
export { Integration } from './context.js';
export type { SessionOptions, CookieReader, CookieWriter, VerifiedContext, WritableContext, AuthOperations, DataClient, MutationOptions } from './context.js';
export { SessionError, type SessionErrorCode } from './errors.js';
export { safeReturnTo } from './policy.js';
export { createGuard, configPath, type Guard, type GuardOptions, type GuardDecision } from './guard.js';
export type { SessionStore, SessionLease, StoredSession } from './store.js';
export { privateResponse } from './private.js';
