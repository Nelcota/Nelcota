import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { Integration, type CookieWriter } from '../src/context.js';
import { PostgresSessionStore } from '../src/postgres.js';
import { SessionSealer } from '../src/seal.js';

it.skipIf(!process.env['NELCOTA_NEXT_TEST_DATABASE_URL'])('serializes two independent store instances and survives connection loss on a disposable database', async () => {
  const connectionString = process.env['NELCOTA_NEXT_TEST_DATABASE_URL']!;
  const name = `nelcota_next_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
  const url = new URL(connectionString); url.pathname = `/${name}`;
  const first = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 2000 });
  const second = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 2000 });
  // node-postgres requires pool error listeners: a terminated idle backend reports FATAL there.
  for (const pool of [admin, first, second]) pool.on('error', () => undefined);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    await first.query(await readFile(new URL('../sql/session-store.sql', import.meta.url), 'utf8'));
    const a = new PostgresSessionStore(first, 2000), b = new PostgresSessionStore(second, 2000);
    const key = 'a'.repeat(64), value = { sealed: 'opaque-one', expiresAt: Date.now() + 60000 };
    let acquired: (() => void) | undefined, release: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = a.exclusive(key, async lease => { await lease.save(value); acquired?.(); await gate; });
    await ready;
    // Independent connection reads a durable save while the owner still holds its lock.
    expect(await b.read(key)).toEqual(value);
    let entered = false;
    const follower = b.exclusive(key, async lease => { entered = true; expect(await lease.load()).toEqual(value); await lease.remove(); });
    const independent = await b.exclusive('b'.repeat(64), async () => true);
    expect(independent).toBe(true); expect(entered).toBe(false);
    release?.(); await owner; await follower; expect(await a.read(key)).toBeNull();
    await expect(a.exclusive(key, async lease => {
      const backend = await first.query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted");
      expect(backend.rows).toHaveLength(1);
      await second.query('SELECT pg_terminate_backend($1)', [backend.rows[0]!.pid]);
      await lease.save(value);
    })).rejects.toBeDefined();
    await b.exclusive(key, async lease => { await lease.save(value); });
    expect(await a.read(key)).toEqual(value);
  } finally {
    await first.end(); await second.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 20000);

type CookieOptions = Parameters<CookieWriter['set']>[2];
class Exchange implements CookieWriter {
  readonly sets: { name: string; value: string; options: CookieOptions }[] = [];
  constructor(readonly presented: Map<string, string>) {}
  get(name: string): { value: string } | undefined { const value = this.presented.get(name); return value ? { value } : undefined; }
  set(name: string, value: string, options: CookieOptions): void { this.sets.push({ name, value, options }); }
}
it.skipIf(!process.env['NELCOTA_NEXT_TEST_DATABASE_URL'])('orders concurrent first sign-ins from two app instances and leaves one credential row', async () => {
  const connectionString = process.env['NELCOTA_NEXT_TEST_DATABASE_URL']!;
  const name = `nelcota_next_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
  const url = new URL(connectionString); url.pathname = `/${name}`;
  const pools = [new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 2000 }), new Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 2000 })];
  for (const pool of [admin, ...pools]) pool.on('error', () => undefined);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    await pools[0]!.query(await readFile(new URL('../sql/session-store.sql', import.meta.url), 'utf8'));
    const secret = randomBytes(32).toString('base64url');
    const fetch = async (target: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const path = new URL(String(target)).pathname;
      if (path === '/auth/v1/token') {
        const user = String(JSON.parse(String(init.body)).email).split('@')[0]!;
        return Response.json({ access_token: `access-${user}`, refresh_token: `refresh-${user}`, token_type: 'bearer', expires_in: 900, expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: user, email: `${user}@example.test`, email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null } });
      }
      const token = new Headers(init.headers).get('authorization')?.replace('Bearer access-', '');
      return Response.json({ id: token, email: `${token}@example.test`, email_confirmed_at: null, user_metadata: {}, created_at: '', last_sign_in_at: null });
    };
    const [one, two] = await Promise.all(pools.map(pool => Integration.create({ url: 'http://localhost:8000', appOrigin: 'http://localhost:3000', keys: [secret], store: new PostgresSessionStore(pool, 2000), allowInsecureDevelopment: true, fetch })));
    const browser = new Map<string, string>();
    const boot = new Exchange(browser);
    one!.bootstrap(boot, boot); browser.set(boot.sets[0]!.name, boot.sets[0]!.value);
    const post = () => new Request('http://localhost:3000/login', { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    const tabA = new Exchange(new Map(browser)), tabB = new Exchange(new Map(browser));
    await Promise.all([
      one!.write(tabA, post(), context => context.auth.signInWithPassword({ email: 'alice@example.test', password: 'fixture-password' })),
      two!.write(tabB, post(), context => context.auth.signInWithPassword({ email: 'bob@example.test', password: 'fixture-password' })),
    ]);
    expect(tabA.sets).toHaveLength(1); expect(tabB.sets).toHaveLength(1);
    // Which instance won the bootstrap lock is not fixed; the later publication is the head.
    const results = await Promise.all([tabA, tabB].map(tab => two!.read(new Exchange(new Map([[tab.sets[0]!.name, tab.sets[0]!.value]])), async context => ({ user: (await context.getUser()).data?.id ?? null, superseded: context.superseded }))));
    expect(results.filter(result => result.superseded)).toHaveLength(1);
    expect(results.filter(result => result.user !== null)).toHaveLength(1);
    // Whichever response the browser keeps, the superseded identity cannot authenticate.
    const sealer = await SessionSealer.create([secret]);
    const rows = await pools[0]!.query<{ key: string; sealed: string }>('SELECT key, sealed FROM nelcota_next.sessions');
    let credentials = 0;
    for (const row of rows.rows) {
      const state = await sealer.open(row.sealed, `nelcota-next/v1\0http://localhost:3000\0http://localhost:8000/\0${row.key}`).catch(() => null);
      if (state?.session) credentials++;
    }
    expect(credentials).toBe(1);
  } finally {
    for (const pool of pools) await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 20000);
