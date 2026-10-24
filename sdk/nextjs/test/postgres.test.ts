import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { PostgresSessionStore, type SessionConnection } from '../src/postgres.js';

const key = 'a'.repeat(64);
const value = () => ({ sealed: 'encrypted-fixture', expiresAt: Date.now() + 60000 });
const lockOnly = async (sql: string) => ({ rows: sql.includes('try_advisory_lock') ? [{ locked: true }] : [] });
function fixture() {
  const query = vi.fn<SessionConnection['query']>(async sql => ({ rows: sql.includes('unlock') ? [{ released: true }] : sql.includes('try_advisory_lock') ? [{ locked: true }] : [] }));
  const release = vi.fn<SessionConnection['release']>();
  const events = new EventEmitter();
  const on = events.on.bind(events), removeListener = events.removeListener.bind(events);
  const pool = { connect: vi.fn(async () => ({ query, release, on, removeListener })) };
  return { pool, query, release, on, removeListener, events };
}
it('commits each save before returning and closes the lease before unlocking', async () => {
  const { pool, query, release } = fixture();
  const store = new PostgresSessionStore(pool);
  let late: (() => Promise<unknown>) | undefined;
  await store.exclusive(key, async lease => { await lease.save(value()); late = lease.remove; expect(lease.signal.aborted).toBe(false); });
  await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
  expect(query.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['SELECT', 'INSERT', 'SELECT']);
  expect(query.mock.calls.some(([sql]) => /BEGIN|COMMIT/.test(sql))).toBe(false);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});
it('surfaces unlock ownership loss and destroys the connection', async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(lockOnly);
  await expect(new PostgresSessionStore(pool).exclusive(key, async () => 'accepted')).rejects.toMatchObject({ code: 'session_store', message: 'Session lock release failed' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('preserves the original callback failure while destroying a failed unlock', async () => {
  const { pool, query, release } = fixture();
  const original = new Error('redirect sentinel');
  query.mockImplementation(lockOnly);
  await expect(new PostgresSessionStore(pool).exclusive(key, async () => { throw original; })).rejects.toBe(original);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('poisons failed persistence even if the caller catches the error', async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async sql => { if (sql.startsWith('INSERT')) throw new Error('connection lost'); return lockOnly(sql); });
  await expect(new PostgresSessionStore(pool).exclusive(key, async lease => {
    await expect(lease.save(value())).rejects.toMatchObject({ code: 'session_store' });
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.remove()).rejects.toMatchObject({ code: 'closed_context' });
  })).rejects.toMatchObject({ code: 'session_store' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('destroys a late connection after its deadline', async () => {
  const { query, release, on, removeListener } = fixture();
  let finish: ((client: SessionConnection) => void) | undefined;
  const store = new PostgresSessionStore({ connect: () => new Promise(resolve => { finish = resolve; }) }, 100);
  await expect(store.read(key)).rejects.toMatchObject({ code: 'session_store' });
  finish?.({ query, release, on, removeListener });
  await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('bounds a stalled owner and prevents late persistence', async () => {
  const { pool, release } = fixture();
  let late: (() => Promise<unknown>) | undefined;
  await expect(new PostgresSessionStore(pool, 100, 200).exclusive(key, lease => { late = lease.remove; return new Promise(() => undefined); })).rejects.toMatchObject({ code: 'session_store' });
  await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('rejects invalid keys before borrowing a connection', async () => {
  const { pool } = fixture();
  await expect(new PostgresSessionStore(pool).read('../bad')).rejects.toMatchObject({ code: 'invalid_session' });
  expect(pool.connect).not.toHaveBeenCalled();
});

it('handles asynchronous connection errors without an uncaught event or stale lease', async () => {
  const { pool, release, events } = fixture();
  await expect(new PostgresSessionStore(pool).exclusive(key, async lease => {
    events.emit('error', new Error('socket closed'));
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.save(value())).rejects.toMatchObject({ code: 'closed_context' });
  })).rejects.toMatchObject({ code: 'session_store' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  // The destroyed client's terminal FATAL arrives after release and stays observed.
  expect(() => events.emit('error', new Error('terminating connection'))).not.toThrow();
});
it('queues a busy key locally so its waiter holds no pooled connection', async () => {
  const { pool, release } = fixture();
  const store = new PostgresSessionStore(pool);
  let open: (() => void) | undefined, entered = false;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const owner = store.exclusive(key, async () => { await gate; });
  await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(1));
  const waiter = store.exclusive(key, async () => { entered = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(pool.connect).toHaveBeenCalledTimes(1); expect(entered).toBe(false);
  await store.exclusive('b'.repeat(64), async () => undefined);
  expect(pool.connect).toHaveBeenCalledTimes(2);
  open?.(); await owner; await waiter;
  expect(entered).toBe(true); expect(pool.connect).toHaveBeenCalledTimes(3);
  expect(release.mock.calls).toEqual([[false], [false], [false]]);
});
it('times out a local waiter without borrowing and keeps later callers ordered', async () => {
  const { pool } = fixture();
  const store = new PostgresSessionStore(pool, 100, 200);
  let open: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const owner = store.exclusive(key, async () => { await gate; });
  await expect(store.exclusive(key, async () => 'late')).rejects.toMatchObject({ code: 'session_store', message: 'Session lock acquisition timed out' });
  expect(pool.connect).toHaveBeenCalledTimes(1);
  const next = store.exclusive(key, async () => 'next');
  open?.(); await owner;
  await expect(next).resolves.toBe('next');
});
it('fails a lock held elsewhere within its deadline without a blocking backend wait', async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async sql => ({ rows: sql.includes('try_advisory_lock') ? [{ locked: false }] : [] }));
  const started = Date.now();
  await expect(new PostgresSessionStore(pool, 100, 200).exclusive(key, async () => 'never')).rejects.toMatchObject({ code: 'session_store', message: 'Session lock acquisition timed out' });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(query.mock.calls.length).toBeGreaterThan(1);
  for (const [sql] of query.mock.calls) { expect(sql).toContain('pg_try_advisory_lock'); expect(sql).not.toMatch(/pg_advisory_lock\(/); }
  // No lock is held and no query is pending, so the clean connection returns to the pool.
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});
it('rotates to a fresh key on the same connection and releases both locks', async () => {
  const { pool, query, release } = fixture();
  const fresh = 'c'.repeat(64);
  await new PostgresSessionStore(pool).exclusive(key, async lease => { await lease.rotate(fresh); await lease.save(value()); });
  const calls = query.mock.calls.map(([sql, values]) => [sql.split(/[ (]/)[0] === 'SELECT' ? sql.match(/pg_\w+/)?.[0] : sql.split(' ')[0], values?.[0]]);
  expect(calls).toEqual([['pg_try_advisory_lock', key], ['pg_try_advisory_lock', fresh], ['DELETE', key], ['INSERT', fresh], ['pg_advisory_unlock', key], ['pg_advisory_unlock', fresh]]);
  expect(pool.connect).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledExactlyOnceWith(false);
});
it('requires a lease that leaves auth time after reserving the final save', async () => {
  const { pool } = fixture();
  expect(() => new PostgresSessionStore(pool, 5000, 9999)).toThrow(expect.objectContaining({ code: 'configuration' }));
  const store = new PostgresSessionStore(pool, 5000, 10000), started = Date.now();
  await store.exclusive(key, async lease => {
    expect(lease.deadline).toBeGreaterThanOrEqual(started + 5000);
    expect(lease.deadline).toBeLessThanOrEqual(Date.now() + 5000);
  });
});
it('replaces the rotated-away row with a retained tombstone instead of deleting it', async () => {
  const { pool, query, release } = fixture();
  const fresh = 'c'.repeat(64), tombstone = value();
  await new PostgresSessionStore(pool).exclusive(key, async lease => { await lease.rotate(fresh, tombstone); });
  const writes = query.mock.calls.filter(([sql]) => !sql.startsWith('SELECT'));
  expect(writes).toEqual([[expect.stringMatching(/^INSERT/), [key, tombstone.sealed, tombstone.expiresAt]]]);
  await expect(new PostgresSessionStore(pool).exclusive(key, lease => lease.rotate(fresh, { sealed: 'x', expiresAt: 1 }))).rejects.toMatchObject({ code: 'invalid_session' });
  expect(release.mock.calls.every(([destroy]) => destroy === false)).toBe(true);
});

it('reads lineage and takes nested locks without borrowing another connection', async () => {
  const { pool, query, release } = fixture();
  const store = new PostgresSessionStore(pool);
  let late: (() => Promise<unknown>) | undefined;
  await store.exclusive(key, async lease => {
    await lease.read!('b'.repeat(64));
    await lease.exclusive!('b'.repeat(64), async owner => {
      await owner.save(value()); late = owner.remove;
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    });
    await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
    await lease.save(value());
  });
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
  expect(query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_unlock'))).toHaveLength(2);
});

it('destroys the parent connection after nested persistence fails', async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async sql => {
    if (sql.startsWith('INSERT')) throw new Error('nested persistence failed');
    return { rows: sql.includes('unlock') ? [{ released: true }] : sql.includes('try_advisory_lock') ? [{ locked: true }] : [] };
  });
  await expect(new PostgresSessionStore(pool).exclusive(key, async lease => {
    await expect(lease.exclusive!('b'.repeat(64), owner => owner.save(value()))).rejects.toBeDefined();
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.load()).rejects.toMatchObject({ code: 'closed_context' });
  })).rejects.toMatchObject({ code: 'session_store' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it('ends a nested lease when its parent times out and refuses late writes', async () => {
  const { pool, release } = fixture();
  let late: (() => Promise<unknown>) | undefined;
  await expect(new PostgresSessionStore(pool, 100, 200).exclusive(key, lease =>
    lease.exclusive!('b'.repeat(64), async owner => {
      late = owner.remove;
      await new Promise(resolve => setTimeout(resolve, 250));
      await owner.remove();
    }),
  )).rejects.toMatchObject({ code: 'session_store' });
  await expect(late?.()).rejects.toMatchObject({ code: 'closed_context' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
