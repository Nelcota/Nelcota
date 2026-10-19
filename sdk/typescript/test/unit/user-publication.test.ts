import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createClient, memoryStorage, type AuthEvent, type Session } from '../../src/index.js';
import { json, session } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

it('preserves sessions backed by class accessors and explicit JSON serialization', async () => {
  const value = session();
  class StoredSession implements Session {
    get access_token() { return value.access_token; }
    get refresh_token() { return value.refresh_token; }
    get token_type() { return value.token_type; }
    get expires_at() { return value.expires_at; }
    get expires_in() { return value.expires_in; }
    get user() { return value.user; }
    toJSON(): Session { return value; }
  }
  const user = { ...value.user, user_metadata: { label: 'new' } };
  const client = createClient('https://api.example.com', { auth: { autoRefresh: false }, fetch: async () => json(user) });
  try {
    await client.auth.setSession(new StoredSession());
    expect((await client.auth.getUser()).data).toEqual(user);
    expect((await client.auth.getSession()).data?.user).toEqual(user);
  } finally { client.dispose(); }
});

describe.each([false, true])('user publication (native journal=%s)', native => {
  it.each(['update', 'refresh', 'replace'] as const)('rejects a late read after %s', async change => {
    if (native) {
      vi.stubGlobal('window', {}); vi.stubGlobal('document', {});
      vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('indexedDB', new IDBFactory());
    }
    const initial = session();
    const nextUser = { ...initial.user, user_metadata: { label: 'new' } };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const client = createClient('https://api.example.com', {
      auth: { autoRefresh: false }, retries: 0,
      fetch: async (url, init) => {
        if (String(url).includes('/token')) return json({ ...initial, refresh_token: 'replacement', user: nextUser });
        if (init?.method === 'PUT') return json(nextUser);
        entered(); await held;
        return json(change === 'replace' ? nextUser : initial.user);
      },
    });
    const events: AuthEvent[] = [];
    client.auth.onChange(event => events.push(event));
    let reading: ReturnType<typeof client.auth.getUser> | undefined;
    try {
      await client.auth.setSession(initial);
      reading = client.auth.getUser(); await started;
      if (change === 'update') await client.auth.updateUser({ data: { label: 'new' } });
      if (change === 'refresh') await client.auth.refreshSession();
      if (change === 'replace') {
        await client.auth.setSession({ ...initial, user: nextUser });
        await client.auth.setSession(initial);
      }
      const before = events.length;
      release(); await reading;
      expect((await client.auth.getSession()).data?.user).toEqual(change === 'replace' ? initial.user : nextUser);
      expect(events).toHaveLength(before);
    } finally { release(); await reading; client.dispose(); }
  });
});

it('preserves an identical native publication by another client', async () => {
  vi.stubGlobal('window', {}); vi.stubGlobal('document', {});
  vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('indexedDB', new IDBFactory());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const initial = session();
  const user = { ...initial.user, user_metadata: { label: 'stale' } };
  const first = createClient('https://api.example.com', {
    auth: { autoRefresh: false }, fetch: async () => { entered(); await held; return json(user); },
  });
  const second = createClient('https://api.example.com', { auth: { autoRefresh: false } });
  let reading: ReturnType<typeof first.auth.getUser> | undefined;
  try {
    await first.auth.setSession(initial);
    reading = first.auth.getUser(); await started;
    await second.auth.setSession({ ...initial, user });
    await second.auth.setSession(initial);
    release(); await reading;
    expect((await first.auth.getSession()).data?.user).toEqual(initial.user);
  } finally { release(); await reading; first.dispose(); second.dispose(); }
});

it('preserves a local replacement when native publication fails without advancing the receipt', async () => {
  const factory = new IDBFactory();
  vi.stubGlobal('window', {}); vi.stubGlobal('document', {});
  vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('indexedDB', factory);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const initial = session();
  const user = { ...initial.user, user_metadata: { label: 'stale' } };
  const client = createClient('https://api.example.com', {
    auth: { autoRefresh: false }, fetch: async () => { entered(); await held; return json(user); },
  });
  let reading: ReturnType<typeof client.auth.getUser> | undefined;
  const open = factory.open.bind(factory);
  let calls = 0;
  try {
    await client.auth.setSession(initial);
    reading = client.auth.getUser(); await started;
    const failure = vi.spyOn(factory, 'open').mockImplementation((...args) => {
      if (++calls % 2 === 0) throw new Error('fixture publication failed');
      return open(...args);
    });
    try {
      await expect(client.auth.setSession({ ...initial, user })).rejects.toThrow('fixture publication failed');
      await expect(client.auth.setSession(initial)).rejects.toThrow('fixture publication failed');
    } finally { failure.mockRestore(); }
    release(); await reading;
    expect((await client.auth.getSession()).data?.user).toEqual(initial.user);
  } finally { release(); await reading; client.dispose(); }
});
