import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createNelcotaSvelteKit, type SvelteKitEvent } from '../src/sveltekit.js';
import { DevelopmentSessionStore } from '../src/memory-store.js';
import type { SessionOptions } from '../src/context.js';

const user = { id: 'user-one', email: 'one@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
const session = () => ({ access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user });
const origin = 'http://localhost:3000';

/** SvelteKit's Cookies: get returns the string; a cookie set during the request is visible to it. */
class Cookies {
  readonly values = new Map<string, string>();
  readonly writes: { name: string; value: string; maxAge: number }[] = [];
  /** Like SvelteKit, refuse writes once the response has been generated. */
  resolved = false;
  get(name: string): string | undefined { return this.values.get(name); }
  set(name: string, value: string, options: { maxAge: number }): void {
    if (this.resolved) throw new Error('Cannot use cookies.set after the response has been generated');
    this.writes.push({ name, value, maxAge: options.maxAge });
    if (options.maxAge === 0) this.values.delete(name); else this.values.set(name, value);
  }
}
const event = (cookies: Cookies, path: string, init: RequestInit = {}): SvelteKitEvent =>
  ({ cookies, url: new URL(path, origin), request: new Request(new URL(path, origin), init) });
const post = (cookies: Cookies, path: string, headers: Record<string, string> = { origin }) => event(cookies, path, { method: 'POST', headers });

async function setup(overrides: Partial<SessionOptions> = {}) {
  const nelcota = await createNelcotaSvelteKit({
    url: 'http://localhost:8000', appOrigin: origin, keys: [randomBytes(32).toString('base64url')],
    store: new DevelopmentSessionStore(), allowInsecureDevelopment: true,
    fetch: async url => {
      const path = new URL(String(url)).pathname;
      return Response.json(path === '/auth/v1/token' ? session() : path === '/auth/v1/user' ? user : []);
    }, ...overrides });
  return { nelcota, cookies: new Cookies() };
}
const signIn = (nelcota: Awaited<ReturnType<typeof setup>>['nelcota'], cookies: Cookies) =>
  nelcota.route(post(cookies, '/auth/login'), async ({ auth }) => {
    const result = await auth.signInWithPassword({ email: 'one@example.test', password: 'fixture-password' });
    return new Response(null, { status: result.error ? 401 : 204 });
  });

describe('SvelteKit adapter', () => {
  it('signs in through an endpoint and reads the session in a load function', async () => {
    const { nelcota, cookies } = await setup();
    const response = await signIn(nelcota, cookies);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(cookies.values.size).toBe(1);
    expect([...cookies.values.values()][0]).toHaveLength(43);
    const email = await nelcota.server(event(cookies, '/'), async ({ hasSession, getUser }) => hasSession ? (await getUser()).data?.email : null);
    expect(email).toBe('one@example.test');
  });

  it('refuses a cross-site form action before any auth request', async () => {
    const fetch = vi.fn<NonNullable<SessionOptions['fetch']>>();
    const { nelcota, cookies } = await setup({ fetch });
    await expect(nelcota.action(post(cookies, '/login', { origin: 'https://evil.example' }), async () => 'done')).rejects.toMatchObject({ code: 'csrf' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes protected paths by session and leaves public paths and /_app assets alone', async () => {
    const { nelcota, cookies } = await setup();
    const handle = nelcota.handle({ protectedPaths: ['/'] });
    const resolve = vi.fn(async () => new Response('page'));
    const anonymous = await handle({ event: event(cookies, '/dashboard?tab=a'), resolve });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(`${origin}/login?next=%2Fdashboard%3Ftab%3Da`);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(resolve).not.toHaveBeenCalled();
    expect((await handle({ event: event(cookies, '/_app/immutable/start.js'), resolve })).status).toBe(200);

    await signIn(nelcota, cookies);
    const allowed = await handle({ event: event(cookies, '/dashboard'), resolve });
    expect(await allowed.text()).toBe('page');
    expect(allowed.headers.get('vary')).toContain('Cookie');
    // A native form POST from this page must carry its real Origin (no-referrer sends null).
    expect(allowed.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('applies routing policies without the app base path', async () => {
    const { nelcota, cookies } = await setup({ basePath: '/app' });
    const handle = nelcota.handle({ protectedPaths: ['/dashboard'] });
    const resolve = vi.fn(async () => new Response('page'));
    const response = await handle({ event: event(cookies, '/app/dashboard'), resolve });
    expect(response.headers.get('location')).toBe(`${origin}/app/login?next=%2Fdashboard`);
    expect((await handle({ event: event(cookies, '/app/about'), resolve })).status).toBe(200);
  });

  it('gives a cookie-less visitor of the login page a bootstrap ID', async () => {
    const { nelcota, cookies } = await setup();
    const handle = nelcota.handle({ protectedPaths: ['/dashboard'] });
    const response = await handle({ event: event(cookies, '/login'), resolve: async () => { cookies.resolved = true; return new Response('login'); } });
    expect(cookies.values.size).toBe(1);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('answers invalid encodings of a protected path with 400', async () => {
    const { nelcota, cookies } = await setup();
    const response = await nelcota.handle({ protectedPaths: ['/dashboard'] })({ event: event(cookies, '/dashboard/%E0%A4%A'), resolve: async () => new Response('page') });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_path' });
  });
});
