import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { Integration, type CookieWriter, type NextOptions } from '../src/context.js';
import { DevelopmentSessionStore } from '../src/memory-store.js';
import { PostgresSessionStore } from '../src/postgres.js';
import { createNelcotaProxy } from '../src/proxy.js';
import { SessionSealer } from '../src/seal.js';
import type { SessionLease, SessionStore } from '../src/store.js';
import { FakePostgres } from './fake-postgres.js';

type CookieOptions = Parameters<CookieWriter['set']>[2];
/** One request's cookie view: what it presented and what its response set. */
class Exchange implements CookieWriter {
  readonly sets: { name: string; value: string; options: CookieOptions }[] = [];
  constructor(readonly presented: Map<string, string>) {}
  get(name: string): { value: string } | undefined { const value = this.presented.get(name); return value ? { value } : undefined; }
  set(name: string, value: string, options: CookieOptions): void { this.sets.push({ name, value, options }); }
}
/** A browser cookie jar: a response's Set-Cookie applies when that response arrives. */
class Browser {
  readonly cookies = new Map<string, string>();
  request(): Exchange { return new Exchange(new Map(this.cookies)); }
  receive(exchange: Exchange): void {
    for (const { name, value, options } of exchange.sets) {
      if (options.maxAge === 0) this.cookies.delete(name);
      if (options.maxAge !== 0) this.cookies.set(name, value);
    }
  }
}
const origin = 'http://localhost:3000', api = 'http://localhost:8000';
const post = () => new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin } });
const userFor = (name: string) => ({ id: `user-${name}`, email: `${name}@example.test`, email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null });
/** Auth fixture: password grants return a session for the submitted email's user. */
const authFetch: NonNullable<NextOptions['fetch']> = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.pathname === '/auth/v1/token') {
    const name = String(JSON.parse(String(init.body)).email).split('@')[0]!;
    return Response.json({ access_token: `access-${name}`, refresh_token: `refresh-${name}`, token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user: userFor(name) });
  }
  if (target.pathname === '/auth/v1/user') {
    const token = new Headers(init.headers).get('authorization')?.replace('Bearer access-', '');
    return token ? Response.json(userFor(token)) : Response.json({ code: 'invalid_token', message: 'No token' }, { status: 401 });
  }
  if (target.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  return Response.json([]);
};
const login = (name: string) => ({ email: `${name}@example.test`, password: 'fixture-password' });

interface Fixture {
  /** Two integrations: separate app instances that share one session store backend. */
  apps: [Integration<unknown>, Integration<unknown>];
  keys: Set<string>;
  read(key: string): Promise<{ sealed: string; expiresAt: number } | null>;
  secret: string;
}
/** Records every key a store touches, including fresh keys reached by rotation. */
function tracked(store: SessionStore, keys: Set<string>): SessionStore {
  const wrap = (lease: SessionLease): SessionLease => ({
    signal: lease.signal, get deadline() { return lease.deadline; },
    load: () => lease.load(), save: value => lease.save(value), remove: () => lease.remove(),
    rotate: async (next, retain) => { keys.add(next); await lease.rotate(next, retain); },
  });
  return { durability: store.durability, read: key => store.read(key), exclusive: (key, work) => { keys.add(key); return store.exclusive(key, lease => work(wrap(lease))); } };
}
const appOptions = (store: SessionStore, secret: string) => ({ url: api, appOrigin: origin, keys: [secret], store, allowInsecureDevelopment: true, fetch: authFetch });
async function memoryFixture(): Promise<Fixture> {
  const store = new DevelopmentSessionStore(), secret = randomBytes(32).toString('base64url'), keys = new Set<string>();
  const shared = tracked(store, keys);
  return { apps: [await Integration.create(appOptions(shared, secret)), await Integration.create(appOptions(shared, secret))], keys, read: key => store.read(key), secret };
}
async function postgresFixture(): Promise<Fixture> {
  const database = new FakePostgres(), secret = randomBytes(32).toString('base64url'), keys = new Set<string>();
  // Separate store instances model separate processes sharing one database.
  const first = new PostgresSessionStore(database.pool(), 200, 2000), second = new PostgresSessionStore(database.pool(), 200, 2000);
  return { apps: [await Integration.create(appOptions(tracked(first, keys), secret)), await Integration.create(appOptions(tracked(second, keys), secret))], keys, read: key => first.read(key), secret };
}
/** Counts stored rows that still hold credentials (decrypts with the fixture key). */
async function credentialRows(fixture: Fixture): Promise<number> {
  const sealer = await SessionSealer.create([fixture.secret]);
  let count = 0;
  for (const key of fixture.keys) {
    const row = await fixture.read(key);
    if (!row) continue;
    const state = await sealer.open(row.sealed, `nelcota-next/v1\0${origin}\0${api}/\0${key}`).catch(() => null);
    if (state?.session) count++;
  }
  return count;
}
async function whoAmI(app: Integration<unknown>, browser: Browser): Promise<{ user: string | null; superseded: boolean }> {
  return app.read(browser.request(), async context => ({ user: (await context.getUser()).data?.id ?? null, superseded: context.superseded }));
}
async function bootstrapped(app: Integration<unknown>): Promise<Browser> {
  const browser = new Browser(), exchange = browser.request();
  expect(app.bootstrap(exchange, exchange)).toBe(true);
  browser.receive(exchange);
  return browser;
}

describe.each([['memory store', memoryFixture], ['PostgreSQL store (mocked pool, two instances)', postgresFixture]])('concurrent first sign-ins — %s', (_name, create) => {
  it('never lets an older identity win when its response arrives last', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    // Two tabs send their sign-in with the same bootstrap cookie, to different instances.
    const tabA = browser.request(), tabB = browser.request();
    const [a, b] = await Promise.all([
      one.write(tabA, post(), context => context.auth.signInWithPassword(login('alice'))),
      two.write(tabB, post(), context => context.auth.signInWithPassword(login('bob'))),
    ]);
    expect(a.data?.id).toBe('user-alice'); expect(b.data?.id).toBe('user-bob');
    expect(tabA.sets).toHaveLength(1); expect(tabB.sets).toHaveLength(1);
    // Responses reordered: the older identity (alice, published first) arrives last.
    browser.receive(tabB); browser.receive(tabA);
    expect(await whoAmI(two, browser)).toEqual({ user: null, superseded: true });
    // The other order selects the newest identity.
    const ordered = new Browser(); ordered.receive(tabA); ordered.receive(tabB);
    expect(await whoAmI(one, ordered)).toEqual({ user: 'user-bob', superseded: false });
    // Only the newest identity keeps credentials; the superseded row is a tombstone.
    expect(await credentialRows(fixture)).toBe(1);
  });
  it('signs the same user in twice and keeps exactly one live row', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const tabA = browser.request(), tabB = browser.request();
    await Promise.all([
      one.write(tabA, post(), context => context.auth.signInWithPassword(login('alice'))),
      two.write(tabB, post(), context => context.auth.signInWithPassword(login('alice'))),
    ]);
    browser.receive(tabB); browser.receive(tabA);
    expect((await whoAmI(one, browser)).superseded).toBe(true);
    expect(await credentialRows(fixture)).toBe(1);
  });
  it('withholds a stale publication when a later sign-in wins while it is still running', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const stale = browser.request();
    const first = browser.request();
    await one.write(first, post(), context => context.auth.signInWithPassword(login('alice')));
    browser.receive(first);
    // Tab A (current cookie) signs in as carol but has not responded yet.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let signedIn!: () => void;
    const entered = new Promise<void>(resolve => { signedIn = resolve; });
    const tabA = browser.request();
    const pending = one.write(tabA, post(), async context => { const result = await context.auth.signInWithPassword(login('carol')); signedIn(); await gate; return result; });
    await entered;
    // A delayed tab still holding the bootstrap ID signs in as bob afterwards.
    const result = await two.write(stale, post(), context => context.auth.signInWithPassword(login('bob')));
    expect(result.data?.id).toBe('user-bob');
    release();
    expect((await pending).data?.id).toBe('user-carol');
    // carol's response is rejected at publication: no Set-Cookie can overwrite bob.
    expect(tabA.sets).toHaveLength(0);
    browser.receive(stale); browser.receive(tabA);
    expect(await whoAmI(one, browser)).toEqual({ user: 'user-bob', superseded: false });
    expect(await credentialRows(fixture)).toBe(1);
  });
  it('lets a delayed sign-out with an older cookie end the newer identity', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const tabA = browser.request(), tabB = browser.request();
    await one.write(tabA, post(), context => context.auth.signInWithPassword(login('alice')));
    browser.receive(tabA);
    await two.write(tabB, post(), context => context.auth.signOut());
    expect(tabB.sets.at(-1)?.options.maxAge).toBe(0);
    // Even if the sign-out response is lost, alice's cookie no longer authenticates.
    expect(await whoAmI(one, browser)).toEqual({ user: null, superseded: true });
    expect(await credentialRows(fixture)).toBe(0);
  });
  it('does not clear the cookie for a stale non-publishing request', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const signIn = browser.request();
    await one.write(signIn, post(), context => context.auth.signInWithPassword(login('alice')));
    const older = new Browser(); older.cookies.set(signIn.sets[0]!.name, signIn.sets[0]!.value);
    browser.receive(signIn);
    const replace = browser.request();
    await one.write(replace, post(), context => context.auth.signInWithPassword(login('bob')));
    browser.receive(replace);
    // A request sent before the replacement arrives late and publishes nothing.
    const late = older.request();
    await two.write(late, post(), async () => undefined);
    expect(late.sets).toHaveLength(0);
    expect(await whoAmI(one, browser)).toEqual({ user: 'user-bob', superseded: false });
  });
  it('residual: cookie-less concurrent sign-ins cannot be linked and both stay valid', async () => {
    const fixture = await create(), [one, two] = fixture.apps;
    const browser = new Browser();
    const tabA = browser.request(), tabB = browser.request();
    await Promise.all([
      one.write(tabA, post(), context => context.auth.signInWithPassword(login('alice'))),
      two.write(tabB, post(), context => context.auth.signInWithPassword(login('bob'))),
    ]);
    browser.receive(tabB); browser.receive(tabA);
    // Without a shared bootstrap ID the server cannot tell these tabs apart from two browsers.
    expect(await whoAmI(one, browser)).toEqual({ user: 'user-alice', superseded: false });
    expect(await credentialRows(fixture)).toBe(2);
  });
});

describe('proxy bootstrap', () => {
  async function proxy(policy: { bootstrapPaths?: string[] } = {}) {
    const options = { url: api, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new DevelopmentSessionStore(), allowInsecureDevelopment: true, fetch: authFetch };
    return { options, handle: await createNelcotaProxy(options, { protectedPaths: ['/profile'], ...policy }) };
  }
  it('issues a credential-free ID on the login page only when the browser has none', async () => {
    const { handle } = await proxy();
    const issued = await handle(new NextRequest(`${origin}/login`));
    const cookie = issued.cookies.getAll()[0]!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(cookie.httpOnly).toBe(true);
    expect(issued.headers.get('cache-control')).toContain('private');
    expect((await handle(new NextRequest(`${origin}/login`, { headers: { cookie: `${cookie.name}=${cookie.value}` } }))).cookies.getAll()).toHaveLength(0);
    expect((await handle(new NextRequest(`${origin}/public`))).cookies.getAll()).toHaveLength(0);
  });
  it('does not clear a superseded cookie on a protected-page redirect', async () => {
    const { options, handle } = await proxy({ bootstrapPaths: ['/login', '/signup'] });
    const app = await Integration.create(options);
    const browser = await bootstrapped(app);
    const first = browser.request();
    await app.write(first, post(), context => context.auth.signInWithPassword(login('alice')));
    const second = browser.request();
    await app.write(second, post(), context => context.auth.signInWithPassword(login('bob')));
    const { name, value } = first.sets[0]!;
    const response = await handle(new NextRequest(`${origin}/profile`, { headers: { cookie: `${name}=${value}` } }));
    expect(response.status).toBe(303); expect(response.cookies.getAll()).toHaveLength(0);
    expect((await handle(new NextRequest(`${origin}/signup`))).cookies.getAll()).toHaveLength(1);
  });
});
