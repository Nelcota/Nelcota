import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { PostgresSessionStore, type SessionConnection } from '../src/postgres.js';

const key = 'a'.repeat(64);
const value = () => ({ sealed: 'encrypted-fixture', expiresAt: Date.now() + 60000 });
function fixture() {
  const query = vi.fn<SessionConnection['query']>(async sql => ({ rows: sql.includes('unlock') ? [{ released: true }] : [] }));
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
  query.mockImplementation(async () => ({ rows: [] }));
  await expect(new PostgresSessionStore(pool).exclusive(key, async () => 'accepted')).rejects.toMatchObject({ code: 'session_store', message: 'Session lock release failed' });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('preserves the original callback failure while destroying a failed unlock', async () => {
  const { pool, query, release } = fixture();
  const original = new Error('redirect sentinel');
  query.mockImplementation(async () => ({ rows: [] }));
  await expect(new PostgresSessionStore(pool).exclusive(key, async () => { throw original; })).rejects.toBe(original);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('poisons failed persistence even if the caller catches the error', async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async sql => { if (sql.startsWith('INSERT')) throw new Error('connection lost'); return { rows: [] }; });
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
  await expect(new PostgresSessionStore(pool, 100, 100).exclusive(key, lease => { late = lease.remove; return new Promise(() => undefined); })).rejects.toMatchObject({ code: 'session_store' });
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
  expect(events.listenerCount('error')).toBe(0);
});
