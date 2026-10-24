import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { PostgresSessionStore } from '../src/postgres.js';

it.skipIf(!process.env['NELCOTA_NEXT_TEST_DATABASE_URL'])('serializes two independent store instances and survives connection loss on a disposable database', async () => {
  const connectionString = process.env['NELCOTA_NEXT_TEST_DATABASE_URL']!;
  const name = `nelcota_next_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
  const url = new URL(connectionString); url.pathname = `/${name}`;
  const first = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 2000 });
  const second = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 2000 });
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
