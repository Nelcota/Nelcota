import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createClient, memoryStorage, type AuthEvent, type NelcotaClient } from '../../src/index.js';
import { json, mockFetch, session } from './helpers.js';
const clients: NelcotaClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.unstubAllGlobals(); });
function browser() {
  vi.stubGlobal('window', {}); vi.stubGlobal('document', {}); vi.stubGlobal('indexedDB', new IDBFactory());
  const values = new Map<string, string>();
  const native = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('localStorage', native);
  const queues = new Map<string, Promise<void>>();
  vi.stubGlobal('navigator', { locks: { request: <T>(name: string, work: () => Promise<T>) => { const run = (queues.get(name) ?? Promise.resolve()).then(work); queues.set(name, run.then(() => undefined, () => undefined)); return run; } } });
  const channels = new Set<Channel>();
  const messages: unknown[] = [];
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | undefined;
    constructor(readonly name: string) { channels.add(this); }
    postMessage(data: unknown): void { messages.push(data); for (const peer of channels) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data })); }
    close(): void { channels.delete(this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  return { native, channels, messages };
}
function client(fetch?: typeof globalThis.fetch, storage?: ReturnType<typeof memoryStorage>) {
  const result = createClient('https://api.example.com', { ...(fetch ? { fetch } : {}), auth: { autoRefresh: false, ...(storage ? { storage } : {}) } }); clients.push(result); return result;
}
it('releases a definite rate-limit reservation for other tabs (#137)', async () => {
  browser(); const mock = mockFetch(json({ code: 'rate_limited', message: 'Busy' }, 429));
  const first = client(mock.fetch); await first.auth.setSession(session());
  const events: AuthEvent[] = []; first.auth.onChange(event => events.push(event));
  expect((await first.auth.refreshSession()).error?.code).toBe('rate_limited'); first.dispose();
  const other = client(); expect((await other.auth.getSession()).data?.refresh_token).toBe('refresh-1'); expect(mock.calls).toHaveLength(1); expect(events).toEqual([]);
});
it('keeps a gateway failure fenced because rotation may have committed (#137)', async () => {
  browser(); const first = client(mockFetch(json({ code: 'unavailable', message: 'Gateway failure' }, 503)).fetch);
  await first.auth.setSession(session()); expect((await first.auth.refreshSession()).error?.status).toBe(503); first.dispose();
  await expect(client().auth.getSession()).rejects.toThrow('interrupted');
});
it('labels profile and account changes in loaded and unread tabs (#138)', async () => {
  browser(); const original = session(); const changed = { ...original.user, user_metadata: { name: 'updated' } };
  const replacement = { ...session(900, 'bob-refresh', 'bob-access'), user: { ...original.user, id: 'bob', email: 'bob@example.test' } };
  const first = client(mockFetch(json(changed), json(replacement)).fetch); await first.auth.setSession(original);
  const loaded = client(), unread = client(); await loaded.auth.getSession();
  const events: AuthEvent[] = [], fresh: AuthEvent[] = [];
  loaded.auth.onChange(event => events.push(event)); unread.auth.onChange(event => fresh.push(event));
  await first.auth.updateUser({ data: { name: 'updated' } });
  await vi.waitFor(() => { expect(events).toEqual(['user_updated']); expect(fresh).toEqual(['user_updated']); });
  await first.auth.signInWithPassword({ email: 'bob@example.test', password: 'pw' });
  await vi.waitFor(() => { expect(events).toEqual(['user_updated', 'signed_in']); expect(fresh).toEqual(['user_updated', 'signed_in']); });
});
it('does not broadcast into independent per-tab adapters (#140)', async () => {
  browser(); const isolated = memoryStorage(); vi.stubGlobal('sessionStorage', isolated);
  const first = client(undefined, memoryStorage()), second = client(undefined, isolated);
  await first.auth.setSession(session()); const own = { ...session(), user: { ...session().user, id: 'carol' } }; await second.auth.setSession(own);
  await second.auth.getSession(); const events: AuthEvent[] = []; second.auth.onChange(event => events.push(event));
  await first.auth.setSession({ ...session(), user: { ...session().user, id: 'bob' } });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(events).toEqual([]); expect((await second.auth.getSession()).data?.user.id).toBe('carol');
});

it('does not label a newer identity with a delayed old logout event (#138)', async () => {
  const environment = browser();
  const replacement = { ...session(), user: { ...session().user, id: 'bob' } };
  const first = client(mockFetch(new Response(null, { status: 204 }), json(replacement)).fetch);
  await first.auth.setSession(session()); await first.auth.signOut();
  const stale = environment.messages.findLast(value => typeof value === 'object' && value !== null && 'event' in value && value.event === 'signed_out');
  await first.auth.signInWithPassword({ email: 'bob@example.test', password: 'pw' });
  const unread = client(); const events: AuthEvent[] = []; unread.auth.onChange(event => events.push(event));
  const channel = [...environment.channels].at(-1)!;
  channel.onmessage?.({ data: stale });
  await vi.waitFor(() => expect(events).toEqual(['signed_in']));
  expect((await unread.auth.getSession()).data?.user.id).toBe('bob');
});

it.each(['rotated', 'invalid_grant'] as const)('broadcasts only signed_out when sign-out renewal is %s', async outcome => {
  const reply = outcome === 'rotated' ? json(session(900, 'rotated', 'fresh')) : json({ code: 'invalid_grant', message: 'Spent' }, 400);
  const environment = browser(); const first = client(mockFetch(reply, new Response(null, { status: 204 })).fetch);
  await first.auth.setSession(session(-60)); environment.messages.length = 0; await first.auth.signOut();
  expect(environment.messages.filter(value => typeof value === 'object')).toEqual([{ event: 'signed_out', revision: expect.any(String) }]);
});
