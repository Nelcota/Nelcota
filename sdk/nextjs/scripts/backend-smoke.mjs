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
import { Integration } from '../dist/context.js';
import { PostgresSessionStore } from '../dist/postgres.js';

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
  await pool.query(await readFile(new URL('../sql/session-store.sql', import.meta.url), 'utf8'));
  await pool.query(`CREATE TABLE public.next_notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner uuid NOT NULL DEFAULT auth.uid(), body text NOT NULL, "limit" integer NOT NULL DEFAULT 5, "order" integer NOT NULL DEFAULT 2);
    ALTER TABLE public.next_notes ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.next_notes TO anon, authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.next_notes_id_seq TO authenticated;
    CREATE POLICY own_notes ON public.next_notes TO authenticated USING (owner=auth.uid()) WITH CHECK (owner=auth.uid());`);
  const integration = await Integration.create({ url: `http://127.0.0.1:${port}`, appOrigin: origin, keys: [randomBytes(32).toString('base64url')], store: new PostgresSessionStore(pool), allowInsecureDevelopment: true });
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
  report = { binary, sha256, checks: ['two real signups', 'verified users', 'two request identities', 'isolated RLS reads', 'anonymous canary empty', 'cross-user update empty', 'SQL integrity', 'reserved filters remain predicates'], database: 'disposable; removed in finally', provenance: 'supplied binary identity recorded; caller must establish its source revision' };
} finally {
  cleaning = true;
  if (server && server.exitCode === null) { const stopped = once(server, 'close'); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 3000); await stopped; clearTimeout(timer); }
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end(); await rm(directory, { recursive: true, force: true });
}

assert.deepEqual(unexpectedPoolErrors, [], 'Unexpected session pool background failure');
console.log(JSON.stringify(report, null, 2));
