import { afterEach, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../src/index.js';
import { createAuthClient } from '../../src/auth/index.js';
import { empty, json, mockFetch, session } from './helpers.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['?code=', '?code=%20', '?error='])('returns error for malformed callback %s (#140)', async search => {
  const mock = mockFetch(json({})); const auth = createAuthClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try { const result = await auth.handleRedirect('https://app.example.com/callback' + search); expect(result.data).toBeNull(); expect(result.error?.code).toBeTruthy(); expect(mock.calls).toHaveLength(0); } finally { auth.dispose(); }
});
it('renews an expired session before revoking it (#134)', async () => {
  const mock = mockFetch(json(session(900, 'rotated', 'fresh')), empty()); const auth = createAuthClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try { await auth.setSession(session(-60)); const result = await auth.signOut(); expect(result.error).toBeNull(); expect(mock.calls.map(call => call.url.pathname)).toEqual(['/auth/v1/token', '/auth/v1/logout']); expect(mock.calls[1]!.headers.get('authorization')).toBe('Bearer fresh'); expect((await auth.getSession()).data).toBeNull(); } finally { auth.dispose(); }
});
it('isolates independent server adapters (#136)', async () => {
  let started!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = createAuthClient('https://api.example.com', { fetch: async () => { started(); await gate; return json(session()); }, auth: { storage: memoryStorage(), autoRefresh: false } });
  const second = createAuthClient('https://api.example.com', { auth: { storage: memoryStorage(), autoRefresh: false } });
  await second.setSession(session()); const pending = first.signInWithPassword({ email: 'one@example.com', password: 'pw' }); await entered;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
  try { expect((await second.getSession({ signal: controller.signal })).error).toBeNull(); } finally { clearTimeout(timer); release(); await pending; first.dispose(); second.dispose(); }
});
function signOutClient(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies), writes: string[] = [], base = memoryStorage(); let broken = false;
  const storage = { getItem: (key: string) => base.getItem(key), setItem: (key: string, value: string) => { if (broken) throw new Error('storage unavailable'); writes.push(value); return base.setItem(key, value); }, removeItem: (key: string) => base.removeItem(key) };
  const auth = createAuthClient('https://api.example.com', { fetch: mock.fetch, auth: { storage, autoRefresh: false } }); const events: string[] = [];
  return { auth, mock, writes, events, start: async (value: ReturnType<typeof session>) => { await auth.setSession(value); writes.length = 0; broken = true; auth.onChange(event => events.push(event)); } };
}
const paths = (mock: ReturnType<typeof mockFetch>) => mock.calls.map(call => `${call.url.pathname} ${call.headers.get('authorization') ?? ''}`.trim());
it('revokes a near-expiry token that is still valid without renewing it', async () => {
  const { auth, mock, events, start } = signOutClient(empty());
  try { await start(session(30)); expect((await auth.signOut()).error).toBeNull(); expect(paths(mock)).toEqual(['/auth/v1/logout Bearer access-1']); expect(events).toEqual(['signed_out']); } finally { auth.dispose(); }
});
it('revokes the current token when renewal inside the clock skew fails', async () => {
  const { auth, mock, start } = signOutClient(json({ code: 'unavailable', message: 'Gateway failure' }, 503), empty());
  try { await start(session(3)); expect((await auth.signOut()).error).toBeNull(); expect(paths(mock)).toEqual(['/auth/v1/token', '/auth/v1/logout Bearer access-1']); } finally { auth.dispose(); }
});
it('does not revoke with an expired token when renewal fails transiently', async () => {
  const { auth, mock, events, start } = signOutClient(json({ code: 'unavailable', message: 'Gateway failure' }, 503));
  try { await start(session(-60)); expect((await auth.signOut()).error?.status).toBe(503); expect(paths(mock)).toEqual(['/auth/v1/token']); expect(events).toEqual(['signed_out']); expect((await auth.getSession()).data).toBeNull(); } finally { auth.dispose(); }
});
it('revokes a rotated token held in memory without persisting or announcing it', async () => {
  const { auth, mock, writes, events, start } = signOutClient(json(session(900, 'rotated', 'fresh')), empty());
  try { await start(session(-60)); expect((await auth.signOut()).error).toBeNull(); expect(paths(mock)).toEqual(['/auth/v1/token', '/auth/v1/logout Bearer fresh']); expect(writes).toEqual([]); expect(events).toEqual(['signed_out']); } finally { auth.dispose(); }
});
it('emits signed_out once when sign-out renewal is rejected as invalid_grant', async () => {
  const { auth, mock, events, start } = signOutClient(json({ code: 'invalid_grant', message: 'Spent' }, 400));
  try { await start(session(-60)); expect((await auth.signOut()).error?.code).toBe('invalid_grant'); expect(paths(mock)).toEqual(['/auth/v1/token']); expect(events).toEqual(['signed_out']); } finally { auth.dispose(); }
});
it('keeps cross-context Web Locks for caller storage in workers', async () => {
  const names: unknown[] = []; vi.stubGlobal('window', undefined); vi.stubGlobal('document', undefined);
  vi.stubGlobal('WorkerGlobalScope', class { static [Symbol.hasInstance](value: unknown) { return value === globalThis; } });
  vi.stubGlobal('navigator', { locks: { request: <T>(name: string, work: () => Promise<T>) => { names.push(name); return work(); } } });
  const shared = createAuthClient('https://api.example.com', { auth: { storage: memoryStorage(), autoRefresh: false } }), own = createAuthClient('https://api.example.com', { auth: { autoRefresh: false } });
  try { await own.getSession(); expect(names).toEqual([]); await shared.getSession(); expect(names).toEqual(['nelcota.api.example.com.session.refresh']); } finally { shared.dispose(); own.dispose(); }
});
