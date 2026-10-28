import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createClient } from '../../src/index.js';
import { BrowserSessionState } from '../../src/auth/browser-state.js';
import { empty, json, mockFetch, session } from './helpers.js';

const KEY = 'nelcota.api.example.com.session';
afterEach(() => vi.unstubAllGlobals());

function browser() {
  const original = JSON.stringify(session(5));
  // A different WebKit process can retain its native storage snapshot even
  // after Web Locks has handed ownership to the next tab. No timer fixes it.
  const storage = { getItem: () => original, setItem: vi.fn(), removeItem: vi.fn() };
  const factory = new IDBFactory();
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {});
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('indexedDB', factory);
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: {
    request: <T>(name: string, callback: () => Promise<T>) => {
      const result = (queues.get(name) ?? Promise.resolve()).then(callback);
      queues.set(name, result.then(() => undefined, () => undefined));
      return result;
    },
  } });
  return { storage, factory };
}

function pkceBrowser() {
  browser();
  const storage = {
    getItem: (key: string) => key.endsWith('.pkce') ? 'stale-verifier' : JSON.stringify(session()),
    setItem: vi.fn(), removeItem: vi.fn(),
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

it('exchanges OAuth with the committed verifier even when the native view is stale', async () => {
  const storage = pkceBrowser();
  const mock = mockFetch(json(session()));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    const published = storage.setItem.mock.calls.find(([key]) => key === `${KEY}.pkce`)?.[1];
    await client.auth.exchangeCode('authorization-code');
    expect(JSON.parse(mock.calls[0]?.body ?? 'null')).toMatchObject({ code_verifier: published });
  } finally { client.dispose(); }
});

it('does not exchange an OAuth code twice from stale native verifier snapshots', async () => {
  pkceBrowser();
  const mock = mockFetch(json(session()), json(session()));
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    expect((await clients[0]!.auth.exchangeCode('authorization-code')).error).toBeNull();
    expect((await clients[1]!.auth.exchangeCode('authorization-code')).error?.code).toBe('pkce_missing');
    expect(mock.calls).toHaveLength(1);
  } finally { clients.forEach(client => client.dispose()); }
});

it('does not consume a pending OAuth verifier for an already cancelled exchange', async () => {
  const storage = pkceBrowser();
  const mock = mockFetch(json(session()));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    expect((await client.auth.exchangeCode('authorization-code', { signal: AbortSignal.abort() })).error?.code).toBe('aborted');
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect((await client.auth.exchangeCode('authorization-code')).error).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally { client.dispose(); }
});

it('persists a claimed OAuth exchange after its caller cancels the wait', async () => {
  pkceBrowser();
  let started!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const mock = mockFetch(async () => {
    started();
    await response;
    return json(session(900, 'accepted-oauth', 'accepted-access'));
  });
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await client.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/auth', redirect: false });
    const abort = new AbortController();
    const exchanged = client.auth.exchangeCode('authorization-code', { signal: abort.signal });
    await pending;
    abort.abort();
    expect((await exchanged).error?.code).toBe('aborted');
    release();
    expect((await client.auth.getSession()).data?.refresh_token).toBe('accepted-oauth');
    expect((await client.auth.exchangeCode('authorization-code')).error?.code).toBe('pkce_missing');
    expect(mock.calls).toHaveLength(1);
  } finally { release(); client.dispose(); }
});

it('hands the committed replacement to a queued tab with a stale native snapshot', async () => {
  browser();
  const mock = mockFetch(json(session(900, 'replacement-1', 'access-1')), json(session(900, 'replacement-2', 'access-2')));
  const clients = [0, 1].map(() => createClient('https://api.example.com', {
    fetch: mock.fetch, auth: { autoRefresh: false },
  }));
  try {
    const values = await Promise.all(clients.map(client => client.auth.getSession()));
    expect(mock.calls).toHaveLength(1);
    expect(values.map(value => value.data?.refresh_token)).toEqual(['replacement-1', 'replacement-1']);
  } finally { clients.forEach(client => client.dispose()); }
});

it('does not resurrect a signed-out session from a stale native mirror or a reopened client', async () => {
  browser();
  const mock = mockFetch(empty());
  const first = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  const other = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await first.auth.setSession(session());
    expect((await other.auth.getSession()).data).not.toBeNull();
    await first.auth.signOut();
    first.dispose();
    expect((await other.auth.getSession()).data).toBeNull();
    expect((await other.auth.refreshSession()).error?.code).toBe('session_missing');
    expect(mock.calls).toHaveLength(1);
    const reopened = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
    try { expect((await reopened.auth.getSession()).data).toBeNull(); }
    finally { reopened.dispose(); }
  } finally { first.dispose(); other.dispose(); }
});

it('keeps logout local when a foreign-owned receipt cannot be replaced', async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('logout commit failed'); });
    return empty();
  });
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.setSession(session());
    await expect(clients[1]!.auth.signOut()).rejects.toThrow('logout commit failed');
    expect((await clients[1]!.auth.getSession()).data).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally { clients.forEach(client => client.dispose()); }
});

it('retains an accepted sign-in when replacing a foreign receipt fails', async () => {
  const { factory } = browser();
  const replacement = session(900, 'signed-in-replacement', 'new-access');
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('sign-in commit failed'); });
    return json(replacement);
  });
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.setSession(session());
    await expect(clients[1]!.auth.signInWithPassword({ email: 'ana@example.com', password: 'example-password' })).rejects.toThrow('sign-in commit failed');
    expect((await clients[1]!.auth.getSession()).data?.refresh_token).toBe('signed-in-replacement');
    expect(mock.calls).toHaveLength(1);
  } finally { clients.forEach(client => client.dispose()); }
});

it('lets a newer foreign logout supersede an accepted sign-in whose write failed', async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('commit failed'); });
    return json(session(900, 'accepted', 'accepted-access'));
  }, empty());
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.setSession(session());
    await expect(clients[1]!.auth.signInWithPassword({ email: 'ana@example.com', password: 'example-password' })).rejects.toThrow('commit failed');
    expect((await clients[1]!.auth.getSession()).data?.refresh_token).toBe('accepted');
    await clients[0]!.auth.signOut();
    expect((await clients[1]!.auth.getSession()).data).toBeNull();
  } finally { clients.forEach(client => client.dispose()); }
});

it('detects a newer foreign commit even when it republishes the identical value', async () => {
  const { factory } = browser();
  const original = session();
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('commit failed'); });
    return empty();
  });
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.setSession(original);
    await expect(clients[1]!.auth.signOut()).rejects.toThrow('commit failed');
    expect((await clients[1]!.auth.getSession()).data).toBeNull();
    // An explicit later session publication is a new decision, even if equal.
    await clients[0]!.auth.setSession(original);
    expect((await clients[1]!.auth.getSession()).data?.refresh_token).toBe(original.refresh_token);
  } finally { clients.forEach(client => client.dispose()); }
});

it('retains an accepted sign-in over an unchanged foreign interrupted reservation', async () => {
  const { factory } = browser();
  const foreign = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await foreign.read(() => JSON.stringify(original));
  await foreign.reserve(original);
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('commit failed'); });
    return json(session(900, 'accepted', 'accepted-access'));
  });
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await expect(client.auth.signInWithPassword({ email: 'ana@example.com', password: 'example-password' })).rejects.toThrow('commit failed');
    expect((await client.auth.getSession()).data?.refresh_token).toBe('accepted');
    await foreign.write(null);
    expect((await client.auth.getSession()).data).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally { client.dispose(); }
});

it('upgrades the original receipt shape without losing its session', async () => {
  const { factory } = browser();
  const state = new BrowserSessionState(KEY, factory);
  await state.read(() => null);
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('nelcota.auth', 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put({ kind: 'ready', owner: 'previous-sdk', value: JSON.stringify(session()) }, KEY);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
    request.onerror = () => reject(request.error);
  });
  const client = createClient('https://api.example.com', { auth: { autoRefresh: false } });
  try { expect((await client.auth.getSession()).data?.refresh_token).toBe('refresh-1'); }
  finally { client.dispose(); }
});

it('retains a received replacement and blocks another owner after its commit fails', async () => {
  const { factory } = browser();
  const failed = new Error('IndexedDB write failed');
  const replacement = session(900, 'replacement', 'access-new');
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw failed; });
    return json(replacement);
  });
  const first = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  const other = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await expect(first.auth.getSession()).rejects.toBe(failed);
    expect((await first.auth.getSession()).data?.refresh_token).toBe('replacement');
    await expect(other.auth.getSession()).rejects.toThrow('interrupted');
    expect(mock.calls).toHaveLength(1);
    await first.auth.setSession(replacement);
    expect((await other.auth.getSession()).data?.refresh_token).toBe('replacement');
    expect(mock.calls).toHaveLength(1);
  } finally { first.dispose(); other.dispose(); }
});

it('lets another tab sign out an interrupted refresh and supersedes the dirty owner', async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('commit failed'); });
    return json(session(900, 'replacement', 'new-access'));
  }, empty());
  const clients = [0, 1].map(() => createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } }));
  try {
    await expect(clients[0]!.auth.getSession()).rejects.toThrow('commit failed');
    await clients[1]!.auth.signOut();
    expect((await clients[0]!.auth.getSession()).data).toBeNull();
    expect((await clients[1]!.auth.getSession()).data).toBeNull();
    expect(mock.calls.map(call => call.url.pathname)).toEqual(['/auth/v1/token', '/auth/v1/logout']);
  } finally { clients.forEach(client => client.dispose()); }
});

it('does not send a refresh when the reservation cannot commit', async () => {
  const { factory } = browser();
  const mock = mockFetch(json(session()));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    // Seed a fresh session, then fail the transaction that reserves rotation.
    await client.auth.setSession(session());
    const original = BrowserSessionState.prototype.reserve;
    const reservation = vi.spyOn(BrowserSessionState.prototype, 'reserve').mockImplementation(function (this: BrowserSessionState, value) {
      vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new Error('reservation failed'); });
      return original.call(this, value);
    });
    try {
      await expect(client.auth.refreshSession()).rejects.toThrow('reservation failed');
      expect(mock.calls).toHaveLength(0);
    } finally { reservation.mockRestore(); }
  } finally { client.dispose(); }
});

it('keeps different API namespaces isolated in the shared database', async () => {
  browser();
  const clients = ['/one', '/two'].map(path => createClient(`https://api.example.com${path}`, { auth: { autoRefresh: false } }));
  try {
    await clients[0]!.auth.setSession(session(900, 'one', 'one-access'));
    await clients[1]!.auth.setSession(session(900, 'two', 'two-access'));
    expect((await clients[0]!.auth.getSession()).data?.refresh_token).toBe('one');
    expect((await clients[1]!.auth.getSession()).data?.refresh_token).toBe('two');
  } finally { clients.forEach(client => client.dispose()); }
});

it('rejects a late refresh completion after another owner signed out', async () => {
  const { factory } = browser();
  const first = new BrowserSessionState(KEY, factory);
  const second = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await first.read(() => JSON.stringify(original));
  await first.reserve(original);
  await second.write(null);
  await expect(first.write(JSON.stringify(session()), true)).rejects.toThrow('changed during refresh');
  expect((await first.read(() => JSON.stringify(original))).value).toBeNull();
});

it('does not emit a replacement session when a late response conflicts with logout', async () => {
  const { factory } = browser();
  let started!: () => void;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<void>(resolve => { complete = resolve; });
  const mock = mockFetch(async () => {
    started();
    await response;
    return json(session(900, 'late-replacement', 'new-access'));
  });
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  const events: unknown[] = [];
  client.auth.onChange((event, value) => { events.push({ event, value }); });
  try {
    const refresh = client.auth.getSession();
    const rejected = expect(refresh).rejects.toThrow('changed during refresh');
    await pending;
    // An independent owner without a shared Web Lock can commit logout.
    await new BrowserSessionState(KEY, factory).write(null);
    complete();
    await rejected;
    expect(events).toEqual([{ event: 'initial_session', value: expect.objectContaining({ refresh_token: 'refresh-1' }) }, { event: 'signed_out', value: null }]);
    expect((await client.auth.getSession()).data).toBeNull();
  } finally { complete(); client.dispose(); }
});

it('can reuse the original session on the same owner after an uncertain network outcome', async () => {
  browser();
  const mock = mockFetch(json({ code: 'gateway_error', message: 'unknown outcome' }, 503), json(session(900, 'replacement', 'new-access')));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    expect((await client.auth.getSession()).error).not.toBeNull();
    expect((await client.auth.refreshSession()).data?.refresh_token).toBe('replacement');
    expect(mock.calls).toHaveLength(2);
  } finally { client.dispose(); }
});

it('rejects malformed receipts and closes storage connections for deletion', async () => {
  const { factory } = browser();
  const state = new BrowserSessionState(KEY, factory);
  await state.read(() => JSON.stringify(session()));
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('nelcota.auth', 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put({ kind: 'ready', owner: 123, value: 'bad' }, KEY);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
    request.onerror = () => reject(request.error);
  });
  await expect(state.read(() => JSON.stringify(session()))).rejects.toThrow('Invalid browser session receipt');
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase('nelcota.auth');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Leaked browser session connection'));
  });
});

it('reports an unavailable or blocked database without sending auth requests', async () => {
  const { factory } = browser();
  await expect(new BrowserSessionState(KEY, undefined).read(() => JSON.stringify(session()))).rejects.toThrow('IndexedDB is required');
  const blocked = {} as IDBOpenDBRequest;
  vi.spyOn(factory, 'open').mockImplementationOnce(() => {
    setTimeout(() => blocked.onblocked?.(new Event('blocked') as IDBVersionChangeEvent), 0);
    return blocked;
  });
  await expect(new BrowserSessionState(KEY, factory).read(() => JSON.stringify(session()))).rejects.toThrow('storage is blocked');
});

it('closes the database when starting a storage request throws synchronously', async () => {
  const { factory } = browser();
  // IndexedDB rejects NaN keys synchronously rather than firing request.onerror.
  const state = new BrowserSessionState(Number.NaN as unknown as string, factory);
  await expect(state.read(() => JSON.stringify(session()))).rejects.toThrow();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase('nelcota.auth');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Leaked browser session connection'));
  });
});
