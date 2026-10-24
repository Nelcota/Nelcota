import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server.js';
import { expect, it, vi } from 'vitest';
import { createNelcotaProxy } from '../src/proxy.js';
import { Integration } from '../src/context.js';
import { DevelopmentSessionStore } from '../src/memory-store.js';

async function setup() {
  const fetch = vi.fn(async () => Response.json({ code: 'invalid_token', message: 'Expired' }, { status: 401 }));
  const options = { url: 'http://localhost:8000', appOrigin: 'http://localhost:3000', keys: [randomBytes(32).toString('base64url')], store: new DevelopmentSessionStore(), allowInsecureDevelopment: true, fetch };
  return { options, fetch, proxy: await createNelcotaProxy(options, { protectedPaths: ['/profile', '/auth/private'] }) };
}
it('redirects anonymous protected pages to a configured origin without fetching auth', async () => {
  const { proxy, fetch } = await setup();
  const response = await proxy(new NextRequest('http://foreign-host.test/profile?tab=one', { headers: { 'x-forwarded-host': 'evil.test' } }));
  const target = new URL(response.headers.get('location')!);
  expect(target.origin).toBe('http://localhost:3000'); expect(target.pathname).toBe('/login'); expect(target.searchParams.get('next')).toBe('/profile?tab=one');
  expect(response.headers.get('cache-control')).toContain('private'); expect(fetch).not.toHaveBeenCalled();
});
it('does not broadly exclude private authentication subroutes', async () => {
  const { proxy } = await setup();
  expect((await proxy(new NextRequest('http://localhost:3000/auth/private'))).status).toBe(303);
  expect((await proxy(new NextRequest('http://localhost:3000/auth/callback'))).headers.get('x-middleware-next')).toBe('1');
});
it('allows public paths without turning the proxy into the authorization boundary', async () => {
  const { proxy, fetch } = await setup();
  expect((await proxy(new NextRequest('http://localhost:3000/public'))).headers.get('x-middleware-next')).toBe('1');
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects encoded separators and does not trust malformed paths', async () => {
  const { proxy } = await setup();
  expect((await proxy(new NextRequest('http://localhost:3000/profile%5cprivate'))).status).toBe(400);
});
it('preserves service errors instead of converting every failure to a login redirect', async () => {
  const { options, fetch, proxy } = await setup();
  const jar = new Map<string, string>();
  const owner = await Integration.create(options);
  fetch.mockResolvedValueOnce(Response.json({ access_token: 'fixture', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: 'one', email: 'one@example.test', user_metadata: {}, created_at: '', email_confirmed_at: null, last_sign_in_at: null } }));
  await owner.write({ get: name => jar.has(name) ? { value: jar.get(name)! } : undefined, set: (name, value) => { jar.set(name, value); } }, new Request('http://localhost:3000/login', { method: 'POST', headers: { origin: 'http://localhost:3000' } }), context => context.auth.signInWithPassword({ email: 'one@example.test', password: 'fixture-password' }));
  const request = () => new NextRequest('http://localhost:3000/profile', { headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } });
  fetch.mockResolvedValueOnce(Response.json({ code: 'unavailable', message: 'Unavailable' }, { status: 503 }));
  expect((await proxy(request())).status).toBe(503);
  fetch.mockResolvedValueOnce(Response.json({ code: 'denied', message: 'Denied' }, { status: 403 }));
  expect((await proxy(request())).status).toBe(403);
  const expired = await proxy(request());
  expect(new URL(expired.headers.get('location')!).pathname).toBe('/auth/refresh');
});
