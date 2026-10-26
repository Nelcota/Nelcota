// Called by the ignored, explicitly selected Next SDK OAuth server contract.
// GitHub token/profile endpoints are local fixtures; Nelcota and PKCE are real.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Integration } from '../../ssr/dist/context.js';
import { DevelopmentSessionStore } from '../../ssr/dist/memory-store.js';

const api = process.env.NELCOTA_NEXT_OAUTH_TEST_URL;
if (!api || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname)) throw new Error('Explicit disposable loopback backend required');
const origin = 'http://localhost:3000';
class Jar {
  values = new Map();
  get(name) { const value = this.values.get(name); return value ? { value } : undefined; }
  set(name, value, options) { if (options.maxAge === 0) { this.values.delete(name); return; } this.values.set(name, value); }
}
const jar = new Jar();
const integration = await Integration.create({ url: api, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new DevelopmentSessionStore(), allowInsecureDevelopment: true });
const start = await integration.write(jar, new Request(`${origin}/login`, { method: 'POST', headers: { origin } }), context => context.auth.startOAuth({ provider: 'github', returnTo: '/profile' }));
assert.equal(start.error, null);
const authorization = await fetch(start.data.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(authorization.status, 303);
const provider = new URL(authorization.headers.get('location'));
// Do not contact the external provider. The harness has already arranged local
// token/profile responses for this code and the generated provider state.
const providerCallback = new URL('/auth/v1/callback', api);
providerCallback.searchParams.set('code', 'good-code');
providerCallback.searchParams.set('state', provider.searchParams.get('state'));
const authorized = await fetch(providerCallback, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(authorized.status, 303);
const callback = new Request(authorized.headers.get('location'));
const code = new URL(callback.url).searchParams.get('code');
await assert.rejects(integration.write(new Jar(), callback, context => context.auth.exchangeCode(code), true), { code: 'csrf' });
const result = await integration.write(jar, callback, context => context.auth.exchangeCode(code), true);
assert.equal(result.error, null); assert.equal(result.data.user.email, 'next-oauth@example.test');
assert.equal(result.data.returnTo, '/profile');
assert(!JSON.stringify(result).includes('refresh_token'));
assert.equal((await integration.read(jar, context => context.getUser())).data.email, 'next-oauth@example.test');
await assert.rejects(integration.write(jar, callback, context => context.auth.exchangeCode(code), true), { code: 'csrf' });
console.log('PASS: Next SDK -> real Nelcota -> local GitHub endpoints -> bound callback -> real PKCE exchange -> verified user; foreign browser and callback replay refused');
