import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Integration, type CookieWriter, type NextOptions } from '../src/context.js';
import { DevelopmentSessionStore } from '../src/memory-store.js';

const origin = 'http://localhost:3000', api = 'http://localhost:8000';
const user = { id: 'user-one', email: 'one@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
class Jar implements CookieWriter {
  readonly values = new Map<string, string>();
  get(name: string): { value: string } | undefined { const value = this.values.get(name); return value ? { value } : undefined; }
  set(name: string, value: string, options: Parameters<CookieWriter['set']>[2]): void { if (options.maxAge === 0) { this.values.delete(name); return; } this.values.set(name, value); }
}
const post = () => new Request(`${origin}/auth/login`, { method: 'POST', headers: { origin } });
interface Sent { url: URL; redirect: RequestRedirect | undefined; headers: Headers }
/** API fixture: `routes` maps an absolute URL to the redirect Location it answers with. */
async function setup(routes: Record<string, string>, overrides: Partial<NextOptions> = {}) {
  const sent: Sent[] = [];
  const integration = await Integration.create({
    url: api, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new DevelopmentSessionStore(), allowInsecureDevelopment: true,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      sent.push({ url, redirect: init.redirect, headers: new Headers(init.headers) });
      if (url.pathname === '/auth/v1/token') return Response.json({ access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user });
      if (url.pathname === '/auth/v1/user') return Response.json(user);
      const location = routes[url.href];
      if (location !== undefined) return new Response('moved', { status: 302, headers: { location } });
      return new Response(`object from ${url.origin}`);
    },
    ...overrides,
  });
  const jar = new Jar();
  await integration.write(jar, post(), context => context.auth.signInWithPassword({ email: 'one@example.test', password: 'fixture-password' }));
  sent.length = 0;
  return { integration, jar, sent };
}
const object = `${api}/storage/v1/object/assets/report.pdf`;
const presigned = 'https://s3.example.test/bucket/report.pdf?X-Amz-Signature=fixture';

describe('storage redirects', () => {
  it('follows an allow-listed presigned redirect without credentials', async () => {
    const { integration, jar, sent } = await setup({ [object]: presigned }, { storageRedirectOrigins: ['https://s3.example.test'] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf', { range: { start: 0, end: 9 } }));
    expect(result.error).toBeNull();
    expect(await result.data?.text()).toBe('object from https://s3.example.test');
    expect(sent.map(request => [request.url.href, request.redirect])).toEqual([[object, 'manual'], [presigned, 'manual']]);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer access-one');
    const hop = sent[1]!.headers;
    expect(hop.get('authorization')).toBeNull(); expect(hop.get('cookie')).toBeNull(); expect(hop.get('apikey')).toBeNull();
    expect(hop.get('range')).toBe('bytes=0-9');
    for (const [name] of hop) expect(['accept', 'range', 'if-none-match', 'if-match', 'if-modified-since', 'if-unmodified-since', 'if-range']).toContain(name);
  });
  it('keeps credentials stripped when a later hop returns to the API origin', async () => {
    const back = `${api}/storage/v1/object/assets/again`;
    const { integration, jar, sent } = await setup({ [object]: presigned, [presigned]: back }, { storageRedirectOrigins: ['https://s3.example.test', api] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').download('report.pdf'));
    expect(result.error).toBeNull();
    expect(sent.map(request => request.headers.get('authorization'))).toEqual(['Bearer access-one', null, null]);
  });
  it('refuses a destination outside the allow-list before contacting it', async () => {
    const { integration, jar, sent } = await setup({ [object]: 'https://attacker.example.test/collect' }, { storageRedirectOrigins: ['https://s3.example.test'] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf'));
    expect(result.error?.code).toBe('storage_redirect_refused');
    expect(sent).toHaveLength(1);
  });
  it('refuses plain HTTP to a non-loopback host, by redirect and by configuration', async () => {
    const { integration, jar, sent } = await setup({ [object]: 'http://s3.example.test/bucket/report.pdf' }, { storageRedirectOrigins: ['https://s3.example.test'] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf'));
    expect(result.error?.code).toBe('storage_redirect_refused'); expect(sent).toHaveLength(1);
    await expect(setup({}, { storageRedirectOrigins: ['http://s3.example.test'] })).rejects.toMatchObject({ code: 'configuration' });
    const keys = [randomBytes(32).toString('base64url')];
    const production = { url: 'https://api.example.test', appOrigin: 'https://app.example.test', keys, store: { durability: 'shared' as const, read: async () => null, exclusive: async () => { throw new Error('unused'); } } };
    await expect(Integration.create({ ...production, storageRedirectOrigins: ['http://127.0.0.1:9000'] })).rejects.toMatchObject({ code: 'configuration' });
    for (const value of ['https://s3.example.test/bucket', 'https://user:pass@s3.example.test', 'https://s3.example.test?x=1', 'not a url']) {
      await expect(Integration.create({ ...production, storageRedirectOrigins: [value] })).rejects.toMatchObject({ code: 'configuration' });
    }
    await expect(Integration.create({ ...production, storageRedirectOrigins: ['https://s3.example.test'] })).resolves.toBeDefined();
  });
  it('allows loopback HTTP destinations only in insecure development', async () => {
    const local = 'http://127.0.0.1:9000/bucket/report.pdf';
    const { integration, jar, sent } = await setup({ [object]: local }, { storageRedirectOrigins: ['http://127.0.0.1:9000'] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf'));
    expect(result.error).toBeNull(); expect(sent.at(-1)?.headers.get('authorization')).toBeNull();
  });
  it('enforces the hop limit', async () => {
    const hop = (n: number) => `https://s3.example.test/hop/${n}`;
    const { integration, jar, sent } = await setup({ [object]: hop(1), [hop(1)]: hop(2), [hop(2)]: hop(3), [hop(3)]: hop(4) }, { storageRedirectOrigins: ['https://s3.example.test'] });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf'));
    expect(result.error?.code).toBe('storage_redirect_limit');
    expect(sent.map(request => request.url.href)).toEqual([object, hop(1), hop(2), hop(3)]);
  });
  it('refuses storage redirects with a clear code when no policy is configured', async () => {
    const { integration, jar, sent } = await setup({ [object]: presigned });
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').open('report.pdf'));
    expect(result.error?.code).toBe('storage_redirect_refused');
    expect(sent).toHaveLength(1);
  });
  it('never follows redirects for non-storage, listing or auth requests', async () => {
    const { integration, jar, sent } = await setup({}, { storageRedirectOrigins: ['https://s3.example.test'] });
    await integration.write(jar, post(), async context => {
      await context.client.from('notes').select();
      await context.client.rpc('mutate');
      await context.client.storage.from('assets').list();
      await context.auth.getUser();
    });
    await integration.read(jar, async context => { await context.client.from('notes').select(); });
    expect(sent.length).toBeGreaterThanOrEqual(5);
    for (const request of sent) expect(request.redirect).toBe('error');
  });
});

it('follows a real loopback redirect with the runtime fetch and strips credentials on the wire', async () => {
  const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<[Server, string]> => new Promise(resolve => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => { const address = server.address(); resolve([server, `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`]); });
  });
  const seen: Record<string, string | undefined>[] = [];
  const [objects, objectOrigin] = await listen((request, response) => {
    seen.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, apikey: request.headers['apikey'] as string | undefined, range: request.headers.range });
    response.end('presigned bytes');
  });
  const [backend, backendOrigin] = await listen((request, response) => {
    if (request.url?.startsWith('/auth/v1/token')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user })); return; }
    if (request.url?.startsWith('/auth/v1/user')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(user)); return; }
    seen.push({ authorization: request.headers.authorization });
    response.writeHead(307, { location: `${objectOrigin}/bucket/report.pdf?X-Amz-Signature=fixture` }); response.end();
  });
  try {
    const integration = await Integration.create({ url: backendOrigin, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new DevelopmentSessionStore(), allowInsecureDevelopment: true, storageRedirectOrigins: [objectOrigin] });
    const jar = new Jar();
    await integration.write(jar, post(), context => context.auth.signInWithPassword({ email: 'one@example.test', password: 'fixture-password' }));
    const result = await integration.write(jar, post(), context => context.client.storage.from('assets').download('report.pdf'));
    expect(result.error).toBeNull(); expect(await result.data?.text()).toBe('presigned bytes');
    expect(seen).toEqual([{ authorization: 'Bearer access-one' }, { authorization: undefined, cookie: undefined, apikey: undefined, range: undefined }]);
  } finally { objects.close(); backend.close(); }
});
