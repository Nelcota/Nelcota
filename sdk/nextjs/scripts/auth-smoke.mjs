// Invoked by sdk/typescript/scripts/contract.ts --nextjs while its real
// disposable Nelcota/PostgreSQL/STARTTLS Mailpit fixture is alive.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Integration } from '../../ssr/dist/context.js';
import { PostgresSessionStore } from '../../ssr/dist/postgres.js';
import { SessionSealer, sessionKey } from '../../ssr/dist/seal.js';

const api = process.env.NELCOTA_SDK_TEST_URL;
const mail = process.env.NELCOTA_SDK_TEST_MAIL;
const connectionString = process.env.NELCOTA_SDK_TEST_DATABASE_URL;
for (const value of [api, mail, connectionString]) {
  if (!value || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) throw new Error('Only explicit loopback contract fixtures are allowed');
}
const origin = 'http://localhost:3000';
const key = randomBytes(32).toString('base64url');
const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 2000, query_timeout: 5000 });
let poolFailure = false;
pool.on('error', () => { poolFailure = true; });
class Jar {
  values = new Map();
  get(name) { const value = this.values.get(name); return value ? { value } : undefined; }
  set(name, value, options) { if (options.maxAge === 0) { this.values.delete(name); return; } this.values.set(name, value); }
}
const password = () => randomBytes(24).toString('base64url');
const request = () => new Request(`${origin}/api/auth`, { method: 'POST', headers: { origin } });
const jar = new Jar();
async function emailLink(address, page) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const list = await (await fetch(`${mail}/api/v1/messages`, { signal: AbortSignal.timeout(2000) })).json();
    for (const summary of list.messages.filter(message => message.To.some(to => to.Address === address))) {
      const full = await (await fetch(`${mail}/api/v1/message/${summary.ID}`, { signal: AbortSignal.timeout(2000) })).json();
      const href = full.Text.split(/\s+/).find(word => word.startsWith(page));
      if (href) return new URLSearchParams(new URL(href).hash.slice(1));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The disposable SMTP fixture did not deliver the expected link');
}
try {
  await pool.query(await readFile(new URL('../../ssr/sql/session-store.sql', import.meta.url), 'utf8'));
  const options = { url: api, appOrigin: origin, keys: [key], store: new PostgresSessionStore(pool), allowInsecureDevelopment: true };
  const integration = await Integration.create(options);
  const second = await Integration.create({ ...options, store: new PostgresSessionStore(pool) });
  const email = `next-${randomBytes(8).toString('hex')}@example.com`, initialPassword = password();
  const write = work => integration.write(jar, request(), work);
  const signedUp = await write(context => context.auth.signUp({ email, password: initialPassword }));
  assert.equal(signedUp.error, null); assert.equal(signedUp.data.confirmationRequired, false);
  assert(!JSON.stringify(signedUp).includes('refresh_token'));
  const id = signedUp.data.user.id;
  assert.equal((await second.read(jar, context => context.getUser())).data.id, id);
  const updated = await write(context => context.auth.updateUser({ data: { display_name: 'Next contract' } }));
  assert.equal(updated.error, null); assert.equal(updated.data.user_metadata.display_name, 'Next contract');
  // Expire only local access metadata. The real server must rotate its refresh
  // token, and eight independent request contexts must not replay that rotation.
  const namespace = `${origin}\0${new URL(api).href}`;
  const storedKey = await sessionKey([...jar.values.values()][0], namespace);
  const binding = `nelcota-next/v1\0${origin}\0${new URL(api).href}\0${storedKey}`;
  const sealer = await SessionSealer.create([key]);
  let previousRefresh;
  await options.store.exclusive(storedKey, async lease => {
    const row = await lease.load(), state = await sealer.open(row.sealed, binding);
    const session = JSON.parse(state.session); previousRefresh = session.refresh_token;
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    state.session = JSON.stringify(session);
    await lease.save({ sealed: await sealer.seal(state, binding), expiresAt: state.expiresAt });
  });
  const refreshed = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? integration : second).write(jar, request(), context => context.auth.refresh())));
  for (const result of refreshed) { assert.equal(result.error, null); assert.equal(result.data.user.id, id); }
  const rotated = await sealer.open((await options.store.read(storedKey)).sealed, binding);
  assert.notEqual(JSON.parse(rotated.session).refresh_token, previousRefresh);
  assert.equal((await write(context => context.auth.requestPasswordReset(email))).error, null);
  const recovery = await emailLink(email, 'https://app.example.com/new-password');
  assert.equal(recovery.get('type'), 'recovery');
  const nextPassword = password();
  const reset = await write(context => context.auth.resetPassword({ token: recovery.get('token'), password: nextPassword }));
  assert.equal(reset.error, null); assert.equal(reset.data.id, id);
  assert((await write(context => context.auth.resetPassword({ token: recovery.get('token'), password: nextPassword }))).error);
  assert.equal((await write(context => context.auth.signOut())).error, null);
  assert.equal(jar.values.size, 0);
  assert((await write(context => context.auth.signInWithPassword({ email, password: initialPassword }))).error);
  assert.equal((await write(context => context.auth.signInWithPassword({ email, password: nextPassword }))).error, null);
  assert.equal((await write(context => context.auth.sendMagicLink(email))).error, null);
  const magic = await emailLink(email, 'https://app.example.com/signed-in');
  assert.equal(magic.get('type'), 'magiclink');
  assert.equal((await write(context => context.auth.verifyEmailLink({ type: 'magiclink', token: magic.get('token') }))).data.id, id);
  assert((await write(context => context.auth.verifyEmailLink({ type: 'magiclink', token: magic.get('token') }))).error);
  assert.equal((await write(context => context.auth.signOut())).error, null);
  assert.equal((await integration.read(jar, context => context.getUser())).error.code, 'session_missing');
  assert.equal(poolFailure, false);
  console.log(JSON.stringify({ backend: 'real disposable Nelcota and PostgreSQL', email: 'real STARTTLS delivery to disposable Mailpit', checks: ['signup', 'verified user across independent stores', 'metadata update', 'eight concurrent refreshes and real token rotation', 'recovery link, replay rejection and password replacement', 'password login', 'magic link and replay rejection', 'logout and cookie removal'], oauth: 'the separately selected nextjs_sdk_finishes_a_real_pkce_flow contract runs the Next SDK against real Nelcota and local provider endpoints' }, null, 2));
} finally { await pool.end(); }
