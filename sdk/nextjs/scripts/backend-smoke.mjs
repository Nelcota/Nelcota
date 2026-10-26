// Explicit binary compatibility test; records binary identity. Never production.
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { SessionSealer, sessionKey } from '../../ssr/dist/seal.js';
// The package entries import `server-only`, which only loads under Next's server condition.
let Integration, PostgresSessionStore;
try { ({ Integration } = await import('../../ssr/dist/context.js')); ({ PostgresSessionStore } = await import('../../ssr/dist/postgres.js')); }
catch (error) {
  if (/Client Component/.test(String(error?.message))) throw new Error('Run with: node --conditions=react-server scripts/backend-smoke.mjs');
  throw error;
}

const binary = process.env.NELCOTA_NEXT_TEST_BINARY;
const connectionString = process.env.NELCOTA_NEXT_TEST_DATABASE_URL;
if (!binary || !connectionString) throw new Error('Explicit disposable database and test binary required');
const database = new URL(connectionString);
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Only a loopback disposable database is allowed');
const name = `nelcota_next_test_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
database.pathname = `/${name}`;
const pool = new Pool({ connectionString: database.href, max: 4, connectionTimeoutMillis: 2000 });
const directory = await mkdtemp(join(tmpdir(), 'nelcota-next-backend-'));
let server, created = false, cleaning = false, report;
const unexpectedPoolErrors = [];
for (const connectionPool of [admin, pool]) connectionPool.on('error', error => {
  // DROP DATABASE FORCE can finish terminating an already-closed idle socket.
  if (cleaning && error.code === '57P01') return;
  unexpectedPoolErrors.push(error.code ?? 'pool_error');
  process.exitCode = 1; // observe background failure without printing credentials
});
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = 'http://localhost:3000';
const request = () => new Request(origin + '/auth/login', { method: 'POST', headers: { origin } });
class Jar {
  values = new Map();
  get(name) { const value = this.values.get(name); return value ? { value } : undefined; }
  set(name, value, options) { if (options.maxAge === 0) this.values.delete(name); else this.values.set(name, value); }
}
try {
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  server = spawn('nice', ['-n', '10', binary, 'serve'], { cwd: directory, env: {
    ...process.env, NELCOTA_DATABASE_URL: database.href,
    NELCOTA_AUTHENTICATOR_PASSWORD: randomBytes(24).toString('base64url'),
    NELCOTA_JWT_SECRET: randomBytes(32).toString('base64url'),
    NELCOTA_LISTEN: `127.0.0.1:${port}`, NELCOTA_STORAGE_BACKEND: 'off', RUST_LOG: 'error',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; server.stderr.on('data', chunk => { if (diagnostics.length < 4000) diagnostics += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (attempt > 100 || server.exitCode !== null) throw new Error('Disposable backend failed to start: ' + diagnostics);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await pool.query(await readFile(new URL('../../ssr/sql/session-store.sql', import.meta.url), 'utf8'));
  await pool.query(`CREATE TABLE public.next_notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner uuid NOT NULL DEFAULT auth.uid(), body text NOT NULL, "limit" integer NOT NULL DEFAULT 5, "order" integer NOT NULL DEFAULT 2);
    ALTER TABLE public.next_notes ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.next_notes TO anon, authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.next_notes_id_seq TO authenticated;
    CREATE POLICY own_notes ON public.next_notes TO authenticated USING (owner=auth.uid()) WITH CHECK (owner=auth.uid());`);
  const keys = [randomBytes(32).toString('base64url')];
  const integration = await Integration.create({ url: `http://127.0.0.1:${port}`, appOrigin: origin, keys, store: new PostgresSessionStore(pool), allowInsecureDevelopment: true });
  const a = new Jar(), b = new Jar();
  for (const [jar, email] of [[a, 'alice@example.test'], [b, 'bob@example.test']]) {
    const result = await integration.write(jar, request(), context => context.auth.signUp({ email, password: randomBytes(24).toString('base64url') }));
    assert.equal(result.error, null); assert.equal(result.data.confirmationRequired, false);
  }
  for (let attempt = 0; ; attempt++) {
    const ready = await integration.read(a, context => context.client.from('next_notes').select());
    if (!ready.error) break;
    if (attempt > 100) throw new Error('Catalog did not discover the fixture');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const [jar, body] of [[a, 'alice-private'], [b, 'bob-private']]) {
    const result = await integration.write(jar, request(), context => context.client.from('next_notes').insert({ body }).select());
    assert.equal(result.error, null); assert.equal(result.data[0].body, body);
  }
  const both = await Promise.all([a, b].map(jar => integration.read(jar, async context => {
    const user = await context.getUser(); assert.equal(user.error, null);
    const rows = await context.client.from('next_notes').select(); assert.equal(rows.error, null);
    return { email: user.data.email, bodies: rows.data.map(row => row.body) };
  })));
  assert.deepEqual(both, [{ email: 'alice@example.test', bodies: ['alice-private'] }, { email: 'bob@example.test', bodies: ['bob-private'] }]);
  const reserved = await integration.read(a, context => context.client.from('next_notes').select().eq('limit', 500).limit(10));
  assert.equal(reserved.error, null); assert.deepEqual(reserved.data, []);
  const ordered = await integration.read(a, context => context.client.from('next_notes').select().eq('order', 99).order('id'));
  assert.equal(ordered.error, null); assert.deepEqual(ordered.data, []);
  const anonymous = await integration.read(new Jar(), context => context.client.from('next_notes').select());
  assert.equal(anonymous.error, null); assert.deepEqual(anonymous.data, []);
  const crossing = await integration.write(a, request(), context => context.client.from('next_notes').update({ body: 'cross-user' }).eq('body', 'bob-private').select());
  assert.equal(crossing.error, null); assert.deepEqual(crossing.data, []);
  assert.equal((await pool.query('SELECT count(*) FROM public.next_notes')).rows[0].count, '2');
  assert.equal((await pool.query("SELECT count(*) FROM public.next_notes WHERE body='cross-user'")).rows[0].count, '0');
  // Negative cases use the same final backend and persisted identities as the controls.
  const snapshot = await pool.query('SELECT key, sealed, expires_at FROM nelcota_next.sessions ORDER BY key');
  for (const headers of [{ origin: 'https://attacker.invalid', host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' }, {}, { origin, 'sec-fetch-site': 'cross-site' }]) {
    await assert.rejects(integration.write(a, new Request(origin + '/auth/logout', { method: 'POST', headers }), context => context.auth.signOut()), { code: 'csrf' });
  }
  assert.deepEqual((await pool.query('SELECT key, sealed, expires_at FROM nelcota_next.sessions ORDER BY key')).rows, snapshot.rows);
  const forged = new Jar();
  for (const [key, value] of a.values) forged.values.set(key, value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a'));
  const forgedRows = await integration.read(forged, context => context.client.from('next_notes').select());
  assert.equal(forgedRows.error, null); assert.deepEqual(forgedRows.data, []);
  const forbiddenInsert = await integration.write(a, request(), async context => {
    const bob = await integration.read(b, other => other.getUser());
    return context.client.from('next_notes').insert({ owner: bob.data.id, body: 'forged-owner' }).select();
  });
  assert(forbiddenInsert.error, 'RLS must reject forged ownership');
  const forbiddenDelete = await integration.write(a, request(), context => context.client.from('next_notes').delete().eq('body', 'bob-private').select());
  assert.equal(forbiddenDelete.error, null); assert.deepEqual(forbiddenDelete.data, []);
  assert.equal((await pool.query('SELECT count(*) FROM public.next_notes')).rows[0].count, '2');

  // Opt-in sustained load: two adapters contend for one small pool and shared keys.
  const seconds = Number(process.env.NELCOTA_NEXT_SOAK_SECONDS ?? 0);
  assert(Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600, 'Invalid soak duration');
  let soak;
  if (seconds) {
    assert(seconds >= 60, 'A soak must run for at least 60 seconds');
    const sibling = await Integration.create({ url: `http://127.0.0.1:${port}`, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new PostgresSessionStore(pool), allowInsecureDevelopment: true });
    // A separate signing key intentionally cannot read the other application's cookies.
    const wrongKey = await sibling.read(a, context => context.client.from('next_notes').select());
    assert.equal(wrongKey.error, null); assert.deepEqual(wrongKey.data, []);
    const peer = await Integration.create({ url: `http://127.0.0.1:${port}`, appOrigin: origin, keys, store: new PostgresSessionStore(pool), allowInsecureDevelopment: true });
    const latencies = [], samples = [];
    const start = performance.now(), until = start + seconds * 1000;
    let operations = 0, maxWaiting = 0, maxConnections = 0;
    const sample = () => {
      samples.push({ elapsedSeconds: Math.round((performance.now() - start) / 1000), rssBytes: process.memoryUsage().rss, poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount });
      maxWaiting = Math.max(maxWaiting, pool.waitingCount); maxConnections = Math.max(maxConnections, pool.totalCount);
    };
    sample(); const timer = setInterval(sample, 1000);
    try {
      await Promise.all(Array.from({ length: 16 }, async (_, worker) => {
        const jar = worker % 2 ? a : b, expected = worker % 2 ? 'alice-private' : 'bob-private';
        while (performance.now() < until) {
          const began = performance.now();
          // The write path acquires/releases advisory locks even for a database read.
          const result = await (worker % 3 ? integration : peer).write(jar, request(), context => context.client.from('next_notes').select());
          assert.equal(result.error, null); assert.deepEqual(result.data.map(row => row.body), [expected]);
          const elapsed = performance.now() - began;
          assert(elapsed < 5000, 'Request exceeded the session store deadline');
          operations++;
          // Bounded reservoir: keep one latency per 100 operations after the first 10k.
          if (latencies.length < 10000 || operations % 100 === 0) latencies.push(elapsed);
          if (latencies.length > 20000) latencies.shift();
        }
      }));
    } finally { clearInterval(timer); }
    sample(); latencies.sort((a, b) => a - b);
    assert(operations >= seconds, 'Insufficient sustained progress');
    assert(pool.totalCount <= 4); assert.equal(pool.waitingCount, 0); assert.equal(pool.idleCount, pool.totalCount);
    const locks = await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())");
    assert.equal(locks.rows[0].count, '0', 'Advisory locks retained after load');
    assert.equal((await pool.query('SELECT count(*) FROM public.next_notes')).rows[0].count, '2');
    const quarter = Math.max(1, Math.floor(samples.length / 4));
    const peak = values => Math.max(...values.map(value => value.rssBytes));
    const rssGrowth = peak(samples.slice(-quarter)) - peak(samples.slice(quarter, 2 * quarter));
    assert(rssGrowth < 128 * 1024 * 1024, 'RSS grew more than 128 MiB after warmup');
    soak = { seconds: (performance.now() - start) / 1000, workers: 16, poolMax: 4, operations, operationsPerSecond: operations / seconds, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.floor(latencies.length * .95)], p99Ms: latencies[Math.floor(latencies.length * .99)], maxWaiting, maxConnections, rssGrowthBytesAfterWarmup: rssGrowth, samples, retainedAdvisoryLocks: 0, errors: 0 };
  }
  const blockedWrite = await integration.read(a, context => context.client.from('next_notes').insert({ body: 'read-only-write' }).select());
  assert.equal(blockedWrite.error?.code, 'read_only');
  let escaped;
  await integration.read(a, async context => { escaped = context.getUser; });
  await assert.rejects(escaped(), { code: 'closed_context' });
  await assert.rejects(integration.write(a, new Request(origin + '/wrong-callback?code=invalid'), context => context.auth.exchangeCode('invalid'), true), { code: 'csrf' });
  await assert.rejects(integration.write(a, new Request(origin + '/auth/callback?code=invalid&state=invalid'), context => context.auth.exchangeCode('invalid'), true), { code: 'csrf' });
  const pending = await integration.write(a, request(), context => context.auth.startOAuth({ provider: 'github', returnTo: '//attacker.invalid' }));
  assert.equal(pending.error, null);
  assert.equal(new URL(new URL(pending.data.url).searchParams.get('redirect_to')).origin, origin);
  const namespace = `${origin}\0${new URL(`http://127.0.0.1:${port}`).href}`;
  const storedKey = sessionKey([...a.values.values()][0], namespace);
  const originalRow = (await pool.query('SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key=$1', [storedKey])).rows[0];
  for (const [label, sealed, expiry] of [['tampered envelope', originalRow.sealed.slice(0, -4) + 'AAAA', originalRow.expires_at], ['expired envelope', originalRow.sealed, Date.now() - 1]]) {
    await pool.query('UPDATE nelcota_next.sessions SET sealed=$2, expires_at=$3 WHERE key=$1', [storedKey, sealed, expiry]);
    const result = await integration.read(a, context => context.client.from('next_notes').select());
    assert.equal(result.error, null, label); assert.deepEqual(result.data, [], label);
  }
  await pool.query('UPDATE nelcota_next.sessions SET sealed=$2, expires_at=$3 WHERE key=$1', [storedKey, originalRow.sealed, originalRow.expires_at]);
  const sealer = await SessionSealer.create(keys);
  const state = await sealer.open(originalRow.sealed, `nelcota-next/v1\0${namespace}\0${storedKey}`);
  assert.equal(state.returnTo, '/', 'Unsafe return path was retained');
  const revoked = await fetch(`http://127.0.0.1:${port}/auth/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${JSON.parse(state.session).access_token}` } });
  assert(revoked.ok, 'Backend logout control failed');
  // Backend logout revokes refresh immediately; access JWTs are stateless until expiry.
  assert.equal((await integration.read(a, context => context.getUser())).data.email, 'alice@example.test');
  const refresh = await fetch(`http://127.0.0.1:${port}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: JSON.parse(state.session).refresh_token }) });
  assert.equal(refresh.status, 400); assert.equal((await refresh.json()).code, 'invalid_grant');
  const oldCookie = new Jar(); for (const [name, value] of a.values) oldCookie.values.set(name, value);
  assert.equal((await integration.write(a, request(), context => context.auth.signOut())).error, null);
  assert.equal(a.values.size, 0);
  const afterLogout = await integration.read(oldCookie, context => context.client.from('next_notes').select());
  assert.equal(afterLogout.error, null); assert.deepEqual(afterLogout.data, []);
  const unwritable = new Jar(); for (const [name, value] of b.values) unwritable.values.set(name, value);
  unwritable.set = () => { throw new Error('Injected cookie publication failure'); };
  await assert.rejects(integration.write(unwritable, request(), context => context.auth.updateUser({ data: { marker: 'accepted-before-cookie-failure' } })), { code: 'session_store' });
  assert.equal((await integration.read(b, context => context.getUser())).data.user_metadata.marker, 'accepted-before-cookie-failure');
  const stopped = once(server, 'close'); server.kill('SIGTERM');
  const killTimer = setTimeout(() => server.kill('SIGKILL'), 3000);
  await stopped; clearTimeout(killTimer);
  const unavailable = await integration.read(b, context => context.getUser());
  assert.equal(unavailable.data, null); assert.equal(unavailable.error?.status, 0);
  const offlineLogout = await integration.write(b, request(), context => context.auth.signOut());
  assert(offlineLogout.error, 'Remote logout must expose transport failure'); assert.equal(b.values.size, 0);
  const afterFailureLocks = await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())");
  assert.equal(afterFailureLocks.rows[0].count, '0');
  report = { binary, sha256, soak, checks: ['two real signups', 'verified users', 'two request identities', 'isolated RLS reads', 'anonymous canary empty', 'cross-user update empty', 'SQL integrity', 'reserved filters remain predicates', 'hostile/missing/cross-site Origin rejected without session mutation', 'forged cookie has no RLS access', 'forged owner insert rejected', 'cross-user delete empty', 'read-only mutation rejected', 'escaped context rejected', 'tampered and expired envelopes cannot access RLS data', 'backend-revoked refresh rejected; stateless access JWT remains valid until expiry', 'local logout clears cookie and fences replayed browser state', 'foreign callback path and malformed state rejected', 'unsafe OAuth return path normalizes to local root', 'cookie publication failure surfaces after accepted backend update', 'stopped backend returns transport failure; offline logout clears local cookie', 'no advisory locks remain after failure paths'], database: 'disposable; removed in finally', provenance: 'supplied binary identity recorded; caller must establish its source revision' };
} finally {
  cleaning = true;
  if (server && server.exitCode === null) { const stopped = once(server, 'close'); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 3000); await stopped; clearTimeout(timer); }
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end(); await rm(directory, { recursive: true, force: true });
}

assert.deepEqual(unexpectedPoolErrors, [], 'Unexpected session pool background failure');
console.log(JSON.stringify(report, null, 2));
