import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createClient, memoryStorage, NelcotaUsageError, type Session } from '../../src/index.js';
import { empty, json, mockFetch, session } from './helpers.js';

const KEY = 'nelcota.api.example.com.session';
afterEach(() => vi.unstubAllGlobals());

it.each([null, {}])('rejects invalid explicit sessions before touching storage: %s', async value => {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const client = createClient('https://api.example.com', { auth: { storage, autoRefresh: false } });
  try {
    await expect(client.auth.setSession(value as unknown as Session)).rejects.toBeInstanceOf(NelcotaUsageError);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  } finally { client.dispose(); }
});

it('still removes pending OAuth state when deleting the session fails', async () => {
  const backing = memoryStorage();
  const storage = { ...backing, removeItem: async (key: string) => {
    if (key === KEY) throw new Error('session deletion failed');
    await backing.removeItem(key);
  } };
  const client = createClient('https://api.example.com', { fetch: async () => empty(204), auth: { storage, autoRefresh: false } });
  try {
    await client.auth.setSession(session());
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    await expect(client.auth.signOut()).rejects.toThrow('session deletion failed');
    expect(await backing.getItem(`${KEY}.pkce`) === null).toBe(true);
  } finally { client.dispose(); }
});

it('preserves a new OAuth flow queued after logout cleanup', async () => {
  const backing = memoryStorage();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const storage = { ...backing, removeItem: async (key: string) => {
    if (key === `${KEY}.pkce`) { entered(); await held; }
    await backing.removeItem(key);
  } };
  const client = createClient('https://api.example.com', { fetch: async () => empty(204), auth: { storage, autoRefresh: false } });
  let signing: Promise<unknown> | undefined;
  let leaving: Promise<unknown> | undefined;
  try {
    await client.auth.setSession(session());
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    leaving = client.auth.signOut();
    await started;
    signing = client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    release();
    await leaving;
    await signing;
    expect(typeof await backing.getItem(`${KEY}.pkce`)).toBe('string');
  } finally { release(); await leaving; await signing; client.dispose(); }
});

it.each([true, false])('clears pending OAuth state on sign-out with an active session=%s', async active => {
  const storage = memoryStorage();
  const mock = mockFetch(empty(204));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { storage, autoRefresh: false } });
  try {
    if (active) await client.auth.setSession(session());
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    expect(typeof await storage.getItem(`${KEY}.pkce`)).toBe('string');
    expect((await client.auth.signOut()).error).toBeNull();
    expect(await storage.getItem(`${KEY}.pkce`) === null).toBe(true);
    expect((await client.auth.exchangeCode('unused')).error?.code).toBe('pkce_missing');
    expect(mock.calls).toHaveLength(active ? 1 : 0);
  } finally { client.dispose(); }
});

it('clears pending OAuth state even when server logout fails', async () => {
  const storage = memoryStorage();
  const mock = mockFetch(json({ code: 'unavailable', message: 'unavailable' }, 503));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { storage, autoRefresh: false } });
  try {
    await client.auth.setSession(session());
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    expect((await client.auth.signOut()).error?.status).toBe(503);
    expect(await storage.getItem(`${KEY}.pkce`) === null).toBe(true);
    expect((await client.auth.getSession()).data).toBeNull();
  } finally { client.dispose(); }
});

it('retires a native verifier in the journal even if another tab retains its legacy snapshot', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: vi.fn(), // A second process may still observe its old native value.
  };
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {});
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  const mock = mockFetch(empty(204));
  const makeClient = () => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  const first = makeClient();
  let second: ReturnType<typeof makeClient> | undefined;
  try {
    await first.auth.setSession(session());
    await first.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    await first.auth.signOut();
    expect(values.has(`${KEY}.pkce`)).toBe(true);
    second = makeClient();
    expect((await second.auth.exchangeCode('unused')).error?.code).toBe('pkce_missing');
    expect(mock.calls).toHaveLength(1);
  } finally { first.dispose(); second?.dispose(); }
});


it.each([false, true])('isolates server PKCE queues and serializes shared adapters (Web Locks=%s)', async webLocks => {
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', webLocks ? { locks: { request: <T>(name: string, task: () => Promise<T>) => {
    const run = (queues.get(name) ?? Promise.resolve()).then(task);
    queues.set(name, run.then(() => undefined, () => undefined));
    return run;
  } } } : undefined);
  const backing = memoryStorage();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const storage = { ...backing, setItem: async (key: string, value: string) => {
    if (key === `${KEY}.pkce`) { entered(); await held; }
    await backing.setItem(key, value);
  } };
  const makeClient = (adapter: typeof backing) => createClient('https://api.example.com', { auth: { storage: adapter, autoRefresh: false } });
  const first = makeClient(storage), shared = makeClient(storage), independent = makeClient(memoryStorage());
  const input = { provider: 'github' as const, redirectTo: 'https://app.example.com/auth', redirect: false };
  let signing: Promise<unknown> | undefined;
  let cleanup: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signing = first.auth.signInWithOAuth(input);
    await started;
    let cleaned = false;
    cleanup = shared.auth.signOut().then(() => { cleaned = true; });
    const result = await Promise.race([
      independent.auth.signInWithOAuth(input).then(() => 'independent'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 250); }),
    ]);
    expect(result).toBe('independent');
    expect(cleaned).toBe(false);
    release();
    await signing;
    await cleanup;
    expect(await backing.getItem(`${KEY}.pkce`)).toBeNull();
  } finally { clearTimeout(timer); release(); await signing; await cleanup; first.dispose(); shared.dispose(); independent.dispose(); }
});
