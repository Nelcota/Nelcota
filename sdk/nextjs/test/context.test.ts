import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Integration, type CookieWriter, type NextOptions } from '../src/context.js';
import { DevelopmentSessionStore } from '../src/memory-store.js';
import { newSessionId } from '../src/seal.js';

const user = { id: 'user-one', email: 'one@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
const session = (token = 'access-one', refresh = 'refresh-one') => ({ access_token: token, refresh_token: refresh, token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user });
class Jar implements CookieWriter {
  readonly values = new Map<string, string>();
  readonly writes: { name: string; value: string; options: Parameters<CookieWriter['set']>[2] }[] = [];
  get(name: string): { value: string } | undefined { const value = this.values.get(name); return value ? { value } : undefined; }
  set(name: string, value: string, options: Parameters<CookieWriter['set']>[2]): void { this.writes.push({ name, value, options }); if (options.maxAge === 0) { this.values.delete(name); return; } this.values.set(name, value); }
}
const post = () => new Request('http://localhost:3000/auth/login', { method: 'POST', headers: { origin: 'http://localhost:3000' } });
async function setup(overrides: Partial<NextOptions> = {}) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const store = new DevelopmentSessionStore();
  const integration = await Integration.create({ url: 'http://localhost:8000', appOrigin: 'http://localhost:3000', keys: [randomBytes(32).toString('base64url')], store, allowInsecureDevelopment: true,
    fetch: async (url, init = {}) => {
      requests.push({ url: new URL(String(url)), init });
      const path = new URL(String(url)).pathname;
      return Response.json(path === '/auth/v1/token' ? session() : path === '/auth/v1/user' ? user : []);
    }, ...overrides });
  return { integration, requests, store, jar: new Jar() };
}
const credentials = { email: 'one@example.test', password: 'fixture-password' };
describe('request-owned sessions', () => {
  it('keeps credentials in encrypted storage and only an opaque HttpOnly cookie in the browser', async () => {
    const { integration, jar, store } = await setup();
    const ownership = vi.spyOn(store, 'exclusive');
    const result = await integration.write(jar, post(), async context => context.auth.signInWithPassword(credentials));
    expect(JSON.stringify(result)).not.toMatch(/access-one|refresh-one/);
    expect(result.data?.id).toBe('user-one');
    expect(jar.writes).toHaveLength(1);
    const cookie = jar.writes[0]!;
    expect(cookie.value).toHaveLength(43); expect(cookie.options.httpOnly).toBe(true); expect(cookie.options.sameSite).toBe('lax');
    const saved = await store.read(ownership.mock.calls[0]![0]);
    expect(saved?.sealed).not.toMatch(/access-one|refresh-one/);
    await integration.read(jar, async context => { expect((await context.getUser()).data?.id).toBe('user-one'); });
    expect(jar.writes).toHaveLength(1);
  });
  it('preserves accepted login when a Next redirect throws', async () => {
    const { integration, jar } = await setup();
    const redirect = new Error('NEXT_REDIRECT');
    await expect(integration.write(jar, post(), async context => { await context.auth.signInWithPassword(credentials); throw redirect; })).rejects.toBe(redirect);
    expect(jar.writes).toHaveLength(1);
    await integration.read(jar, async context => { expect((await context.getUser()).data?.id).toBe('user-one'); });
  });
  it('rejects unsafe origin before HTTP, cookies or session mutation', async () => {
    const { integration, requests, jar } = await setup();
    await expect(integration.write(jar, new Request('http://localhost:3000/auth/login', { method: 'POST', headers: { origin: 'https://evil.test' } }), async context => context.auth.signInWithPassword(credentials))).rejects.toMatchObject({ code: 'csrf' });
    expect(requests).toHaveLength(0); expect(jar.writes).toHaveLength(0);
  });
  it('refuses component writes and use after the request ends', async () => {
    const { integration, requests, jar } = await setup();
    let late: (() => Promise<unknown>) | undefined;
    await integration.read(jar, async context => {
      const result = await context.client.rpc('mutate');
      expect(result.error?.code).toBe('read_only');
      late = context.getUser;
    });
    await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
    expect(requests).toHaveLength(0);
  });
  it('surfaces failed cookie writes and never exposes encryption keys in inspection', async () => {
    const { integration, jar } = await setup();
    jar.set = () => { throw new Error('cookie store is read-only'); };
    await expect(integration.write(jar, post(), async context => context.auth.signInWithPassword(credentials))).rejects.toMatchObject({ code: 'session_store', message: 'Session cookie publication failed' });
    expect(JSON.stringify(integration)).toBe('{}');
  });
  it('never sends cookies to the API and forces private uncached fetches', async () => {
    const { integration, requests, jar } = await setup();
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    await integration.read(jar, context => context.getUser());
    for (const request of requests) { expect(request.init.cache).toBe('no-store'); expect(request.init.redirect).toBe('error'); expect(new Headers(request.init.headers).has('cookie')).toBe(false); }
  });
  it('rejects production memory stores and remote development origins', async () => {
    const keys = [randomBytes(32).toString('base64url')], store = new DevelopmentSessionStore();
    await expect(Integration.create({ url: 'https://api.test', appOrigin: 'https://app.test', keys, store })).rejects.toMatchObject({ code: 'configuration' });
    await expect(Integration.create({ url: 'https://api.test', appOrigin: 'https://app.test', keys, store, allowInsecureDevelopment: true })).rejects.toMatchObject({ code: 'configuration' });
  });
});

it('binds OAuth callbacks to the initiating browser and consumes state exactly once', async () => {
  const { integration, jar, requests } = await setup();
  const started = await integration.write(jar, post(), context => context.auth.startOAuth({ provider: 'github', returnTo: '/profile' }));
  expect(started.error).toBeNull();
  const redirect = new URL(new URL(started.data!.url).searchParams.get('redirect_to')!);
  const state = redirect.searchParams.get('state')!;
  const callback = (nonce: string) => new Request(`http://localhost:3000/auth/callback?code=fixture&state=${encodeURIComponent(nonce)}`);
  await expect(integration.write(jar, callback('a'.repeat(43)), context => context.auth.exchangeCode('fixture'), true)).rejects.toMatchObject({ code: 'csrf' });
  await expect(integration.write(jar, callback('é'.repeat(43)), context => context.auth.exchangeCode('fixture'), true)).rejects.toMatchObject({ code: 'csrf' });
  expect(requests).toHaveLength(0);
  const exchanged = await integration.write(jar, callback(state), context => context.auth.exchangeCode('fixture'), true);
  expect(exchanged.data?.returnTo).toBe('/profile'); expect(exchanged.data?.user.id).toBe(user.id);
  expect(requests).toHaveLength(1);
  await expect(integration.write(jar, callback(state), context => context.auth.exchangeCode('fixture'), true)).rejects.toMatchObject({ code: 'csrf' });
  expect(requests).toHaveLength(1);
});
it('refuses ordinary mutations and data writes in a callback GET', async () => {
  const { integration, jar, requests } = await setup();
  const request = new Request('http://localhost:3000/auth/callback');
  await expect(integration.write(jar, request, context => context.auth.signInWithPassword(credentials), true)).rejects.toMatchObject({ code: 'csrf' });
  await integration.write(jar, request, async context => { expect((await context.client.rpc('mutate')).error?.code).toBe('read_only'); }, true);
  expect(requests).toHaveLength(0);
});
it('isolates cookie namespaces when applications share the same store and key', async () => {
  const first = await setup();
  const second = await setup({ store: first.store, appOrigin: 'http://localhost:3001' });
  await first.integration.write(first.jar, post(), context => context.auth.signInWithPassword(credentials));
  await second.integration.read(first.jar, async context => { expect(context.hasSession).toBe(false); expect((await context.getUser()).error?.code).toBe('session_missing'); });
  expect(second.requests).toHaveLength(0);
});
it('drains accepted auth operations in FIFO order and rejects late callers', async () => {
  const { integration, jar, requests } = await setup();
  let late: (() => Promise<unknown>) | undefined;
  await integration.write(jar, post(), async context => {
    const first = context.auth.signInWithPassword(credentials);
    const second = context.auth.signInWithPassword(credentials);
    late = () => context.auth.signInWithPassword(credentials);
    await first; await second;
  });
  expect(requests).toHaveLength(2);
  await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
  expect(requests).toHaveLength(2);
});
it('supports an explicit local reset without decrypting unavailable state', async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  await original.integration.write(original.jar, post(), context => context.auth.signInWithPassword(credentials));
  const rotated = await setup({ store });
  await rotated.integration.read(original.jar, async context => { expect(context.hasSession).toBe(false); expect(context.staleCookie).toBe(true); });
  await rotated.integration.forget(original.jar, post());
  await rotated.integration.read(original.jar, async context => { expect(context.hasSession).toBe(false); });
  expect(original.jar.values.size).toBe(0);
});
it('cancels a pending OAuth identity when a password login succeeds', async () => {
  const { integration, jar, requests } = await setup();
  const start = await integration.write(jar, post(), context => context.auth.startOAuth({ provider: 'github' }));
  const callback = new URL(new URL(start.data!.url).searchParams.get('redirect_to')!);
  await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
  await expect(integration.write(jar, new Request(callback), context => context.auth.exchangeCode('old-pending-code'), true)).rejects.toMatchObject({ code: 'csrf' });
  expect(requests).toHaveLength(1);
});
it('grants a new absolute lifetime to a successful replacement login', async () => {
  const { integration, jar } = await setup({ sessionTtlSeconds: 300 });
  await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 290000);
  try {
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    expect(jar.writes.at(-1)?.options.maxAge).toBe(300);
  } finally { clock.mockRestore(); }
});
it('does not abort an accepted storage response stream when its session lease closes', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | null | undefined;
  const { integration, jar } = await setup({ fetch: async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
  } });
  const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('file'));
  expect(result.error).toBeNull(); expect(signal?.aborted).toBe(false);
  stream?.enqueue(new TextEncoder().encode('accepted stream')); stream?.close();
  expect(await result.data?.text()).toBe('accepted stream');
});
it('ends the adapter header deadline before handing a stream to its caller', async () => {
  let signal: AbortSignal | null | undefined;
  const { integration, jar } = await setup({ timeout: 100, fetch: async (_url, init) => {
    signal = init?.signal; return new Response('accepted object');
  } });
  const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('file'));
  expect(result.error).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(signal?.aborted).toBe(false);
  expect(await result.data?.text()).toBe('accepted object');
});
it('treats rows sealed with lost keys as signed out and lets login replace them', async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  await original.integration.write(original.jar, post(), context => context.auth.signInWithPassword(credentials));
  const rotated = await setup({ store });
  await rotated.integration.read(original.jar, async context => {
    expect(context.hasSession).toBe(false); expect(context.staleCookie).toBe(true);
    expect((await context.getUser()).error?.code).toBe('session_missing');
  });
  const result = await rotated.integration.write(original.jar, post(), context => context.auth.signInWithPassword(credentials));
  expect(result.data?.id).toBe('user-one');
  await rotated.integration.read(original.jar, async context => { expect(context.hasSession).toBe(true); expect((await context.getUser()).data?.id).toBe('user-one'); });
});
it('removes an unreadable row and clears its cookie when a write saves nothing', async () => {
  const store = new DevelopmentSessionStore();
  const original = await setup({ store });
  const ownership = vi.spyOn(store, 'exclusive');
  await original.integration.write(original.jar, post(), context => context.auth.signInWithPassword(credentials));
  const key = ownership.mock.calls[0]![0];
  const rotated = await setup({ store });
  await rotated.integration.write(original.jar, post(), async () => undefined);
  expect(await store.read(key)).toBeNull();
  expect(original.jar.writes.at(-1)?.options.maxAge).toBe(0); expect(original.jar.values.size).toBe(0);
  expect(rotated.requests).toHaveLength(0);
});
it('counts a row that expires between the store check and decryption as expired', async () => {
  const { integration, jar, store } = await setup({ sessionTtlSeconds: 300 });
  await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
  const read = store.read.bind(store), now = Date.now();
  const clock = vi.spyOn(Date, 'now');
  vi.spyOn(store, 'read').mockImplementation(async key => { const row = await read(key); clock.mockReturnValue(now + 301000); return row; });
  try { await integration.read(jar, async context => { expect(context.hasSession).toBe(false); expect(context.staleCookie).toBe(true); }); }
  finally { clock.mockRestore(); }
});
describe('session fixation', () => {
  it('never adopts a well-formed cookie that has no stored row', async () => {
    const { integration, jar, store } = await setup();
    const probe = new Jar();
    await integration.write(probe, post(), context => context.auth.signInWithPassword(credentials));
    const name = probe.writes[0]!.name;
    const planted = newSessionId();
    jar.values.set(name, planted);
    const ownership = vi.spyOn(store, 'exclusive');
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    const issued = jar.writes.at(-1)!;
    expect(issued.name).toBe(name); expect(issued.value).toHaveLength(43); expect(issued.value).not.toBe(planted); expect(issued.options.maxAge).toBeGreaterThan(0);
    expect(await store.read(ownership.mock.calls[0]![0])).toBeNull();
  });
  it('rotates the ID when a login replaces an existing session and removes the old row', async () => {
    const { integration, jar, store } = await setup();
    const ownership = vi.spyOn(store, 'exclusive');
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    const first = jar.writes.at(-1)!;
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    const second = jar.writes.at(-1)!;
    expect(second.name).toBe(first.name); expect(second.value).not.toBe(first.value);
    expect(await store.read(ownership.mock.calls[1]![0])).toBeNull();
    const stale = new Jar(); stale.values.set(first.name, first.value);
    await integration.read(stale, async context => { expect(context.hasSession).toBe(false); });
    await integration.read(jar, async context => { expect(context.hasSession).toBe(true); });
  });
  it('rotates the pre-login OAuth ID on code exchange but keeps it for non-identity writes', async () => {
    const { integration, jar } = await setup();
    const started = await integration.write(jar, post(), context => context.auth.startOAuth({ provider: 'github' }));
    const initial = jar.writes.at(-1)!.value;
    await integration.write(jar, post(), async () => undefined);
    expect(jar.writes.at(-1)!.value).toBe(initial);
    const redirect = new URL(new URL(started.data!.url).searchParams.get('redirect_to')!);
    const exchanged = await integration.write(jar, new Request(`http://localhost:3000/auth/callback?code=fixture&state=${redirect.searchParams.get('state')}`), context => context.auth.exchangeCode('fixture'), true);
    expect(exchanged.error).toBeNull();
    expect(jar.writes.at(-1)!.value).not.toBe(initial); expect(jar.writes.at(-1)!.options.maxAge).toBeGreaterThan(0);
  });
  it('clears an unknown cookie when the write publishes nothing', async () => {
    const { integration, jar } = await setup();
    await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    const name = jar.writes[0]!.name;
    const stranger = new Jar(); stranger.values.set(name, newSessionId());
    await integration.write(stranger, post(), async () => undefined);
    expect(stranger.writes).toHaveLength(1); expect(stranger.writes[0]!.options.maxAge).toBe(0);
  });
});
describe('refresh outages', () => {
  async function expiring() {
    let refresh: Response | undefined;
    const requests: string[] = [];
    const fixture = await setup({ fetch: async url => {
      const target = new URL(String(url)); requests.push(`${target.pathname}${target.search}`);
      if (target.searchParams.get('grant_type') === 'refresh_token') return refresh ?? Response.json({}, { status: 500 });
      if (target.pathname === '/auth/v1/token') return Response.json({ ...session(), expires_in: 60, expires_at: Math.floor(Date.now() / 1000) + 1 });
      return Response.json(target.pathname === '/auth/v1/user' ? user : null);
    } });
    await fixture.integration.write(fixture.jar, post(), context => context.auth.signInWithPassword(credentials));
    refresh = Response.json({ code: 'unavailable', message: 'Unavailable' }, { status: 503 });
    requests.length = 0;
    return { ...fixture, requests };
  }
  it('signs out locally while the refresh endpoint returns 503', async () => {
    const { integration, jar, requests } = await expiring();
    const result = await integration.write(jar, post(), context => context.auth.signOut());
    expect(result.error?.status).toBe(503);
    expect(requests.every(path => path.includes('grant_type=refresh_token'))).toBe(true);
    expect(jar.writes.at(-1)?.options.maxAge).toBe(0); expect(jar.values.size).toBe(0);
    await integration.read(jar, async context => { expect(context.hasSession).toBe(false); });
  });
  it('still runs sign-in when the pre-refresh fails', async () => {
    const { integration, jar } = await expiring();
    const result = await integration.write(jar, post(), context => context.auth.signInWithPassword(credentials));
    expect(result.data?.id).toBe('user-one');
  });
});
