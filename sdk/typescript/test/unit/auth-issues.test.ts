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
