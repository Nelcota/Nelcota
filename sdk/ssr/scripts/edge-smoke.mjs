// Bundle the core for web runtimes and execute it without Node globals/imports.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes, webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--sandbox')) {
  const temporary = mkdtempSync(join(tmpdir(), 'nelcota-edge-'));
  try {
    const result = await Bun.build({ entrypoints: [join(root, 'src/index.ts'), join(root, 'src/seal.ts'), join(root, 'src/memory-store.ts')], target: 'browser', format: 'esm', minify: false });
    if (!result.success) throw new Error(String(result.logs));
    const sources = await Promise.all(result.outputs.map(async output => [output.path.split('/').at(-1), await output.text()]));
    const path = join(temporary, 'bundles.json');
    writeFileSync(path, JSON.stringify(Object.fromEntries(sources)));
    const child = spawnSync('node', ['--experimental-vm-modules', fileURLToPath(import.meta.url), '--sandbox', path], { stdio: 'inherit' });
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else {
  const sources = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
  const context = vm.createContext({ crypto: webcrypto, URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal, TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout, structuredClone });
  const load = async name => {
    const module = new vm.SourceTextModule(sources[name], { context });
    await module.link(() => { throw new Error('The Edge bundle must not import Node modules'); });
    await module.evaluate();
    return module.namespace;
  };
  const { Integration } = await load('index.js');
  const { SessionSealer, sessionKey } = await load('seal.js');
  const { DevelopmentSessionStore } = await load('memory-store.js');
  assert.equal(vm.runInContext('typeof Buffer + ":" + typeof process + ":" + typeof require', context), 'undefined:undefined:undefined');
  const secret = randomBytes(32).toString('base64url');
  const state = { schema: 1, session: 'old-session', pkce: null, oauthState: null, returnTo: '/', expiresAt: Date.now() + 60_000 };
  const sealer = await SessionSealer.create([secret]);
  const raw = Buffer.from(secret, 'base64url');
  const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  // Independent construction of both previously released formats.
  for (const version of ['v1', 'v2']) {
    const salt = randomBytes(16), iv = randomBytes(12);
    let key = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    if (version === 'v2') {
      const hkdf = await webcrypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
      key = await webcrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: Buffer.from(`nelcota-next/seal/v2\0${keyId}`) }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    }
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('binding') }, key, Buffer.from(JSON.stringify(state)));
    const body = Buffer.concat([...(version === 'v2' ? [salt] : []), iv, Buffer.from(encrypted)]).toString('base64url');
    const envelope = `${version}.${keyId}.${body}`;
    assert.equal((await sealer.open(envelope, 'binding')).session, 'old-session');
    await assert.rejects(sealer.open(envelope, 'other-project'));
  }
  const id = randomBytes(32).toString('base64url');
  assert.equal(await sessionKey(id, 'namespace'), createHash('sha256').update('namespace\0').update(id).digest('hex'));
  const store = new DevelopmentSessionStore();
  const values = new Map();
  const cookies = { get: name => values.has(name) ? { value: values.get(name) } : undefined, set: (name, value, options) => { if (options.maxAge === 0) { values.delete(name); return; } values.set(name, value); } };
  const user = { id: 'edge-user', email: 'edge@example.test', email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null };
  const session = { access_token: 'edge-access', refresh_token: 'edge-refresh', token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user };
  const integration = await Integration.create({ url: 'http://localhost:8000', appOrigin: 'http://localhost:3000', keys: [secret], store, allowInsecureDevelopment: true,
    fetch: async url => String(url).includes('/token') ? Response.json(session) : Response.json(user) });
  const post = new Request('http://localhost:3000/auth/signin', { method: 'POST', headers: { origin: 'http://localhost:3000' } });
  const signedIn = await integration.write(cookies, post, context => context.auth.signInWithPassword({ email: user.email, password: 'test' }));
  assert.equal(signedIn.data.id, 'edge-user');
  await integration.read(cookies, context => { assert.equal(context.hasSession, true); });
  assert.equal([...values.values()].every(value => /^[A-Za-z0-9_-]{43}$/.test(value)), true);
  await assert.rejects(integration.write(cookies, new Request('http://localhost:3000/auth/signin', { method: 'POST', headers: { origin: 'https://attacker.test' } }), async () => {}));
  await integration.write(cookies, post, context => context.auth.signOut());
  await integration.read(cookies, context => { assert.equal(context.hasSession, false); });
  console.log('PASS: web bundle without Node globals, released v1/v2 envelopes, stable hashes, opaque-cookie sign-in/read/sign-out and CSRF rejection');
}
