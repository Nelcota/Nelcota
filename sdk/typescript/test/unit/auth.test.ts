import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createClient, memoryStorage, NelcotaUsageError, type AuthEvent, type SessionStorage } from '../../src/index.js';
import { challengeFor } from '../../src/auth/pkce.js';
import { empty, json, mockFetch, session } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = 'nelcota.api.example.com.session';

describe('isolated default server clients', () => {
  it.each([false, true])('keeps an independent cached session readable during another client sign-in (Web Locks=%s)', async (webLocks) => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    const queues = new Map<string, Promise<void>>();
    vi.stubGlobal('navigator', {});
    if (webLocks) vi.stubGlobal('navigator', { locks: {
      request: <T>(name: string, task: () => Promise<T>) => {
        const result = (queues.get(name) ?? Promise.resolve()).then(task);
        queues.set(name, result.then(() => undefined, () => undefined));
        return result;
      },
    } });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = createClient('https://api.example.com', {
      fetch: async () => { entered(); await held; return json(session(900, 'slow-refresh')); },
      auth: { autoRefresh: false },
    });
    const independent = createClient('https://api.example.com', {
      fetch: async () => { throw new Error('A cached session read must not send HTTP'); },
      auth: { autoRefresh: false },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signing: Promise<unknown> | undefined;
    try {
      await independent.auth.setSession(session(900, 'independent-refresh'));
      signing = slow.auth.signInWithPassword({ email: 'ana@example.com', password: 'pw' });
      await started;
      const cancel = new AbortController();
      timer = setTimeout(() => cancel.abort(), 1000);
      const result = await independent.auth.getSession({ signal: cancel.signal });
      expect(result.error).toBeNull();
      expect(result.data?.refresh_token).toBe('independent-refresh');
    } finally {
      clearTimeout(timer);
      release();
      await signing;
      slow.dispose();
      independent.dispose();
    }
  });
});

function setup(storage: SessionStorage = memoryStorage(), ...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  const nelcota = createClient('https://api.example.com', {
    fetch: mock.fetch,
    auth: { storage, autoRefresh: false },
  });
  const events: AuthEvent[] = [];
  nelcota.auth.onChange((event) => events.push(event));
  return { nelcota, calls: mock.calls, storage, events };
}

function stored(value: unknown): SessionStorage {
  const storage = memoryStorage();
  void storage.setItem(KEY, JSON.stringify(value));
  return storage;
}

describe.each([false, true])('queued authentication cancellation (Web Locks=%s)', webLocks => {
  it.each(['signUp', 'signInWithPassword', 'verifyEmailLink', 'resetPassword'] as const)('cancels %s before the lifecycle owner finishes', async method => {
    vi.useFakeTimers();
    const queues = new Map<string, Promise<void>>();
    vi.stubGlobal('navigator', webLocks ? { locks: {
      request: <T>(name: string, task: () => Promise<T>) => {
        const result = (queues.get(name) ?? Promise.resolve()).then(task);
        queues.set(name, result.then(() => undefined, () => undefined));
        return result;
      },
    } } : {});
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { nelcota, calls } = setup(stored(session()), async () => {
      entered(); await held; return json(session(900, 'replacement'));
    });
    const rotating = nelcota.auth.refreshSession();
    await started;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const actions = {
      signUp: () => nelcota.auth.signUp({ email: 'a@example.com', password: 'pw' }, options),
      signInWithPassword: () => nelcota.auth.signInWithPassword({ email: 'a@example.com', password: 'pw' }, options),
      verifyEmailLink: () => nelcota.auth.verifyEmailLink({ type: 'signup', token: 'fixture' }, options),
      resetPassword: () => nelcota.auth.resetPassword({ token: 'fixture', password: 'pw' }, options),
    };
    let code: string | undefined;
    const pending = actions[method]().then(result => { code = result.error?.code; });
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(code).toBe('aborted');
      expect(calls).toHaveLength(1);
    } finally {
      release(); await Promise.all([rotating, pending]);
      expect(calls).toHaveLength(1);
      expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('replacement');
      nelcota.dispose(); vi.useRealTimers();
    }
  });
});

it('finishes an accepted session publication after its sign-in waiter cancels', async () => {
  vi.useFakeTimers();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const backing = memoryStorage();
  const storage: SessionStorage = {
    ...backing,
    setItem: async (key, value) => { entered(); await held; await backing.setItem(key, value); },
  };
  const { nelcota, calls } = setup(storage, json(session()));
  const controller = new AbortController();
  let code: string | undefined;
  const pending = nelcota.auth.signInWithPassword({ email: 'a@example.com', password: 'pw' }, { signal: controller.signal })
    .then(result => { code = result.error?.code; });
  await started;
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe('aborted');
    expect(await backing.getItem(KEY)).toBeNull();
  } finally {
    release(); await pending;
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('refresh-1');
    expect(JSON.parse((await backing.getItem(KEY))!).refresh_token).toBe('refresh-1');
    expect(calls).toHaveLength(1);
    nelcota.dispose(); vi.useRealTimers();
  }
});

describe('session storage keys', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['////', ''],
    ['/api', '/api'],
    ['/api///', '/api'],
    ['/api//v1///', '/api//v1'],
    ['/api%2F///', '/api%2F'],
  ])('normalizes trailing slashes in %s while retaining the base path', async (path, normalized) => {
    const storage = memoryStorage();
    const nelcota = createClient(`https://api.example.com${path}`, { auth: { storage, autoRefresh: false } });
    const value = session();
    try {
      await nelcota.auth.setSession(value);
      expect(JSON.parse((await storage.getItem(`nelcota.api.example.com${normalized}.session`))!)).toEqual(value);
    } finally { nelcota.dispose(); }
  });

  it('handles a long slash sequence followed by a non-slash without backtracking', async () => {
    const path = `/api/${'/'.repeat(100_000)}x///`;
    const storage = memoryStorage();
    const started = performance.now();
    const nelcota = createClient(`https://api.example.com${path}`, { auth: { storage, autoRefresh: false } });
    const elapsed = performance.now() - started;
    try {
      expect(elapsed).toBeLessThan(1000);
      await nelcota.auth.setSession(session());
      expect(await storage.getItem(`nelcota.api.example.com${path.slice(0, -3)}.session`)).not.toBeNull();
    } finally { nelcota.dispose(); }
  });

  it('honors a custom storage key', async () => {
    const storage = memoryStorage();
    const nelcota = createClient('https://api.example.com/api///', {
      auth: { storage, storageKey: 'custom-session', autoRefresh: false },
    });
    try {
      await nelcota.auth.setSession(session());
      expect(await storage.getItem('custom-session')).not.toBeNull();
      expect(await storage.getItem('nelcota.api.example.com/api.session')).toBeNull();
    } finally { nelcota.dispose(); }
  });
});

describe('password sign-in', () => {
  it('persists a pending sign-in after disposal without broadcasting on a closed channel', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    let finish!: (response: Response) => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const { nelcota, storage } = setup(memoryStorage(), async () => { started(); return response; });
    const pending = nelcota.auth.signInWithPassword({ email: 'a@x.com', password: 'pw' });
    await begun;
    nelcota.dispose();
    nelcota.dispose();
    finish(json(session()));
    expect((await pending).error).toBeNull();
    expect(JSON.parse((await storage.getItem(KEY))!).refresh_token).toBe('refresh-1');
  });
  it('accepts cancellation options without sending an aborted sign-in', async () => {
    const { nelcota, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    expect((await nelcota.auth.signInWithPassword({ email: 'a@x.com', password: 'pw' }, { signal: controller.signal })).error?.code).toBe('aborted');
    expect(calls).toHaveLength(0);
  });
  it('stores the session, emits signed_in and uses the token', async () => {
    const { nelcota, calls, storage, events } = setup(memoryStorage(), json(session()), json([]));
    const { data, error } = await nelcota.auth.signInWithPassword({ email: ' ana@example.com ', password: 'pw' });
    expect(error).toBeNull();
    expect(data?.access_token).toBe('access-1');
    expect(calls[0]!.url.search).toBe('?grant_type=password');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: 'ana@example.com', password: 'pw' });
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(JSON.parse((await storage.getItem(KEY))!).refresh_token).toBe('refresh-1');
    expect(events).toEqual(['signed_in']);

    await nelcota.from('notes').select();
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('returns the server error and stores nothing', async () => {
    const { nelcota, storage } = setup(memoryStorage(), json({ code: 'invalid_credentials', message: 'no' }, 400));
    const { error } = await nelcota.auth.signInWithPassword({ email: 'a@x.com', password: 'bad' });
    expect(error).toMatchObject({ status: 400, code: 'invalid_credentials' });
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it('sign-up without a session while the email awaits confirmation', async () => {
    const { nelcota, storage } = setup(memoryStorage(), json({ user: session().user }, 201));
    const { data } = await nelcota.auth.signUp({ email: 'ana@example.com', password: 'pw', data: { name: 'Ana' } });
    expect(data?.session).toBeNull();
    expect(data?.user.email).toBe('ana@example.com');
    expect(await storage.getItem(KEY)).toBeNull();
  });
});

describe('refresh', () => {
  it.each([false, true])('coalesces a late native-browser refresh while another tab is rotating (warm=%s)', async (warm) => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    const committed = new Map([[KEY, JSON.stringify(session())]]);
    const storage = {
      getItem: (key: string) => committed.get(key) ?? null,
      setItem: (key: string, value: string) => { committed.set(key, value); },
      removeItem: (key: string) => { committed.delete(key); },
    };
    vi.stubGlobal('localStorage', storage);
    let queue: Promise<unknown> = Promise.resolve();
    let pending = false;
    let waiting = 0;
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let laterQueued!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const queued = new Promise<void>((resolve) => { laterQueued = resolve; });
    vi.stubGlobal('navigator', { locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        if (pending && ++waiting === 2) laterQueued();
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
      },
    } });
    let rotations = 0;
    const mock = mockFetch(async () => {
      rotations++;
      if (rotations === 1) {
        pending = true;
        firstStarted();
        await release;
        pending = false;
      }
      return json(session(900, `refresh-${rotations + 1}`, `access-${rotations + 1}`));
    });
    const clients = [0, 1, 2].map(() => createClient('https://api.example.com', {
      fetch: mock.fetch, auth: { autoRefresh: false },
    }));
    try {
      await clients[0]!.auth.getSession();
      if (warm) await Promise.all(clients.slice(1).map(client => client.auth.getSession()));
      const first = clients[0]!.auth.refreshSession();
      await started;
      const later = clients.slice(1).map(client => client.auth.refreshSession());
      await queued;
      expect(rotations).toBe(1);
      releaseFirst();
      const results = await Promise.all([first, ...later]);
      expect(rotations).toBe(1);
      expect(results.every(result => result.error === null)).toBe(true);
      expect(results.map(result => result.data?.refresh_token)).toEqual(['refresh-2', 'refresh-2', 'refresh-2']);
      const subsequent = await clients[1]!.auth.refreshSession();
      expect(rotations).toBe(2);
      expect(subsequent.data?.refresh_token).toBe('refresh-3');
      // A stale per-client cache must not suppress a later explicit refresh.
      const following = await clients[0]!.auth.refreshSession();
      expect(rotations).toBe(3);
      expect(following.data?.refresh_token).toBe('refresh-4');
    } finally {
      releaseFirst();
      clients.forEach(client => client.dispose());
    }
  });

  it('leaves the lock-grant task before reading a native storage snapshot', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    let committed = JSON.stringify(session(5));
    let visible = committed;
    const storage = {
      getItem: () => visible,
      setItem: (_key: string, value: string) => { committed = visible = value; },
      removeItem: () => { committed = visible = ''; },
    };
    vi.stubGlobal('localStorage', storage);
    let queue: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', { locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        // A queued tab can enter the callback with its earlier storage view.
        // The write becomes visible on the next task, independently of the lock.
        const snapshot = committed;
        const result = queue.then(() => {
          visible = snapshot;
          setTimeout(() => { visible = committed; }, 0);
          return task();
        });
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
    } });
    const mock = mockFetch(json(session(900, 'refresh-2', 'access-2')), json(session(900, 'refresh-3', 'access-3')));
    const clients = [0, 1].map(() => createClient('https://api.example.com', {
      fetch: mock.fetch, auth: { autoRefresh: false },
    }));
    try {
      const results = await Promise.all(clients.map(client => client.auth.getSession()));
      expect(mock.calls).toHaveLength(1);
      expect(results.map(result => result.data?.refresh_token)).toEqual(['refresh-2', 'refresh-2']);
    } finally { clients.forEach(client => client.dispose()); }
  });

  it('observes native writes published after the previous owner releases the lock', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    const committed = new Map([[KEY, JSON.stringify(session(5))]]);
    const storage = {
      getItem: (key: string) => committed.get(key) ?? null,
      // Firefox can publish a native localStorage write at a task boundary,
      // after its synchronous setItem has already returned.
      setItem: (key: string, value: string) => { setTimeout(() => committed.set(key, value), 0); },
      removeItem: (key: string) => { setTimeout(() => committed.delete(key), 0); },
    };
    vi.stubGlobal('localStorage', storage);
    let queue: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', { locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        const result = queue.then(task);
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
    } });
    const mock = mockFetch(json(session(900, 'refresh-2', 'access-2')), json(session(900, 'refresh-3', 'access-3')));
    const clients = [0, 1].map(() => createClient('https://api.example.com', {
      fetch: mock.fetch, auth: { autoRefresh: false },
    }));
    try {
      const results = await Promise.all(clients.map(client => client.auth.getSession()));
      expect(mock.calls).toHaveLength(1);
      expect(results.map(result => result.data?.refresh_token)).toEqual(['refresh-2', 'refresh-2']);
      await vi.waitFor(() => expect(JSON.parse(storage.getItem(KEY)!).refresh_token).toBe('refresh-2'));
    } finally { clients.forEach(client => client.dispose()); }
  });

  it('uses another tab\'s replacement when its broadcast reload overtakes an expired read', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    let channel!: { onmessage?: (event: { data: string }) => void };
    vi.stubGlobal('BroadcastChannel', class {
      onmessage?: (event: { data: string }) => void;
      constructor() { channel = this; }
      close() {}
      postMessage() {}
    });
    const storage = stored(session(5));
    const replacement = session(900, 'refresh-2', 'access-2');
    let queue = Promise.resolve(), requests = 0;
    vi.stubGlobal('navigator', { locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        const number = ++requests;
        const run = queue.then(async () => {
          const value = await task();
          if (number === 1) {
            // The first read captured the expiring session. Another tab
            // publishes and broadcasts its replacement before that read settles.
            await storage.setItem(KEY, JSON.stringify(replacement));
            channel.onmessage?.({ data: 'changed' });
          }
          return value;
        });
        queue = run.then(() => {}, () => {});
        return run;
      },
    } });
    const { nelcota, calls } = setup(storage, json(session(900, 'refresh-3', 'access-3')));
    try {
      const result = await nelcota.auth.getSession();
      expect(result.data?.refresh_token).toBe('refresh-2');
      expect(calls).toHaveLength(0);
      expect(JSON.parse((await storage.getItem(KEY))!).refresh_token).toBe('refresh-2');
    } finally { nelcota.dispose(); }
  });

  it('cancels each waiter independently and persists an accepted rotation', async () => {
    let started!: () => void, finish!: (response: Response) => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let requestSignal: AbortSignal | null | undefined;
    let calls = 0;
    const storage = stored(session(30));
    const nelcota = createClient('https://api.example.com', {
      auth: { storage, autoRefresh: false },
      fetch: async (_input, init) => {
        calls++;
        requestSignal = init?.signal;
        started();
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const cancelled = nelcota.auth.refreshSession({ signal: controller.signal });
    await begun;
    const survivor = nelcota.auth.refreshSession();
    try {
      controller.abort();
      expect((await cancelled).error?.code).toBe('aborted');
      expect(requestSignal?.aborted).not.toBe(true);
      finish(json(session(900, 'refresh-2', 'access-2')));
      expect((await survivor).data?.refresh_token).toBe('refresh-2');
      expect(JSON.parse((await storage.getItem(KEY))!).refresh_token).toBe('refresh-2');
      expect(calls).toBe(1);
    } finally { finish(json(session(900, 'refresh-2', 'access-2'))); nelcota.dispose(); }
  });

  it('does not start a rotation for an already cancelled caller', async () => {
    const { nelcota, calls } = setup(stored(session(30)), json(session()));
    const controller = new AbortController();
    controller.abort();
    expect((await nelcota.auth.refreshSession({ signal: controller.signal })).error?.code).toBe('aborted');
    expect((await nelcota.auth.getSession({ signal: controller.signal })).error?.code).toBe('aborted');
    expect(calls).toHaveLength(0);
    nelcota.dispose();
  });

  it('cancels getSession while another caller holds the lifecycle lock', async () => {
    vi.useFakeTimers();
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const { nelcota } = setup(stored(session(30)), async () => {
      started(); await wait; return json(session(900, 'refresh-2', 'access-2'));
    });
    const refresh = nelcota.auth.refreshSession();
    await begun;
    const controller = new AbortController();
    let code: string | undefined;
    const pending = nelcota.auth.getSession({ signal: controller.signal }).then(result => { code = result.error?.code; });
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(code).toBe('aborted');
    } finally {
      finish(); await Promise.all([refresh, pending]); nelcota.dispose(); vi.useRealTimers();
    }
  });

  it('coordinates clients sharing an adapter without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const storage = stored(session(30));
    let refreshes = 0;
    const reply = async () => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return json(session(900, 'refresh-2', 'access-2'));
    };
    const a = setup(storage, reply);
    const b = setup(storage, reply);
    const results = await Promise.all([a.nelcota.auth.getSession(), b.nelcota.auth.getSession()]);
    expect(refreshes).toBe(1);
    expect(results.map((result) => result.data?.refresh_token)).toEqual(['refresh-2', 'refresh-2']);
  });

  it('does not restore a session when logout overlaps a refresh', async () => {
    let started!: () => void;
    let finish!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const { nelcota, storage } = setup(stored(session(30)), async (request) => {
      if (request.url.pathname !== '/auth/v1/token') return empty();
      started(); await wait;
      return json(session(900, 'refresh-2', 'access-2'));
    });
    const refresh = nelcota.auth.refreshSession();
    await begun;
    const logout = nelcota.auth.signOut();
    finish();
    expect((await refresh).error).toBeNull();
    expect((await logout).error).toBeNull();
    expect((await nelcota.auth.getSession()).data).toBeNull();
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it('does not rearm background timers after dispose during refresh', async () => {
    vi.useFakeTimers();
    try {
      const mock = mockFetch(json(session(900, 'refresh-2', 'access-2')));
      const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: true } });
      await nelcota.auth.setSession(session(120));
      const refresh = nelcota.auth.refreshSession();
      nelcota.dispose(); await refresh;
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(mock.calls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('refreshes a session about to expire before using it', async () => {
    const { nelcota, calls, events } = setup(stored(session(30)), json(session(900, 'refresh-2', 'access-2')), json([]));
    await nelcota.from('notes').select();
    expect(calls[0]!.url.search).toBe('?grant_type=refresh_token');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ refresh_token: 'refresh-1' });
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer access-2');
    expect(events).toEqual(['refreshed']);
  });

  it('sends one refresh for many concurrent requests', async () => {
    const { nelcota, calls } = setup(stored(session(30)), (request) =>
      request.url.pathname === '/auth/v1/token' ? json(session(900, 'refresh-2', 'access-2')) : json([]),
    );
    await Promise.all([1, 2, 3, 4, 5].map(() => nelcota.from('notes').select()));
    expect(calls.filter((c) => c.url.pathname === '/auth/v1/token')).toHaveLength(1);
    expect(calls.filter((c) => c.headers.get('authorization') === 'Bearer access-2')).toHaveLength(5);
  });

  it('serializes refreshes across tabs: the second tab takes the first one\'s result', async () => {
    // A Web Lock shared by two clients with the same storage (two tabs).
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: <T>(_name: string, task: () => Promise<T>) => {
          const run = queue.then(task);
          queue = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        },
      },
    });
    const storage = stored(session(30));
    let refreshes = 0;
    const reply = async (request: { url: URL }) => {
      if (request.url.pathname !== '/auth/v1/token') return json([]);
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return json(session(900, 'refresh-2', 'access-2'));
    };
    const tabA = setup(storage, reply);
    const tabB = setup(storage, reply);
    const [a, b] = await Promise.all([tabA.nelcota.auth.getSession(), tabB.nelcota.auth.getSession()]);
    expect(refreshes).toBe(1);
    expect(a.data?.access_token).toBe('access-2');
    expect(b.data?.access_token).toBe('access-2');
  });

  it('a rejected refresh token signs out', async () => {
    const { nelcota, storage, events } = setup(
      stored(session(30)),
      json({ code: 'invalid_grant', message: 'refresh token reused; session ended' }, 400),
    );
    expect(await nelcota.auth.getSession()).toEqual({ data: null, error: null });
    expect(await storage.getItem(KEY)).toBeNull();
    expect(events).toEqual(['signed_out']);
  });

  it('a transient failure keeps the session and still sends its token (never a silent visitor)', async () => {
    const { nelcota, calls, storage } = setup(stored(session(-5)), (request) => {
      if (request.url.pathname === '/auth/v1/token') throw new TypeError('fetch failed');
      return json({ code: 'invalid_token', message: 'expired' }, 401);
    });
    const { error } = await nelcota.from('notes').select();
    expect(error?.status).toBe(401);
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer access-1');
    expect(await storage.getItem(KEY)).not.toBeNull();
  });

  it('drops a corrupted stored session', async () => {
    const storage = memoryStorage();
    await storage.setItem(KEY, '{"access_token": 1}');
    const { nelcota } = setup(storage, json([]));
    expect((await nelcota.auth.getSession()).data).toBeNull();
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it('refreshes in the background before expiry', async () => {
    vi.useFakeTimers();
    try {
      const mock = mockFetch(json(session(900, 'refresh-2', 'access-2')));
      const nelcota = createClient('https://api.example.com', {
        fetch: mock.fetch,
        auth: { storage: stored(session(120)), autoRefresh: true, refreshMargin: 60 },
      });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(mock.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(mock.calls).toHaveLength(1);
      expect((await nelcota.auth.getSession()).data?.access_token).toBe('access-2');
      nelcota.auth.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([30, 900])('bounds the refresh margin by the %s-second token lifetime', async lifetime => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fresh = () => ({ ...session(lifetime), expires_in: lifetime });
    const mock = mockFetch(() => json(fresh()));
    const nelcota = createClient('https://api.example.com', {
      fetch: mock.fetch,
      auth: { autoRefresh: true, refreshMargin: 3600 },
    });
    try {
      await nelcota.auth.setSession(fresh());
      await nelcota.auth.getSession();
      expect(mock.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(lifetime * 500 - 1);
      expect(mock.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(mock.calls).toHaveLength(1);
      await nelcota.auth.getSession();
      expect(mock.calls).toHaveLength(1);
    } finally { nelcota.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('retries an uncertain background refresh inside the server reuse window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // The rotation may have committed before the 503: only a retry under 10 s recovers it.
    const mock = mockFetch(json({ message: 'gateway' }, 503), json(session(900, 'refresh-2', 'access-2')));
    const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: true, refreshMargin: 60 } });
    try {
      await nelcota.auth.setSession(session(61));
      await vi.advanceTimersByTimeAsync(1000);
      expect(mock.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(mock.calls).toHaveLength(2);
      expect((await nelcota.auth.getSession()).data?.access_token).toBe('access-2');
    } finally { nelcota.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('backs off when the server returns an already expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const expired = () => ({ ...session(0), expires_in: 0 });
    const mock = mockFetch(() => json(expired()), json({ code: 'invalid_grant', message: 'stop unexpected rotation' }, 400));
    const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: true } });
    try {
      await nelcota.auth.setSession(expired());
      await vi.advanceTimersByTimeAsync(1000);
      expect(mock.calls.length).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mock.calls).toHaveLength(1);
    } finally { nelcota.dispose(); vi.useRealTimers(); }
  });
});

describe('background adapter failures', () => {
  it.each([false, true, 'async'])('observes startup storage failure and isolates its handler (throws: %s)', async throws => {
    vi.useFakeTimers();
    const failed = new Error('storage unavailable');
    const storage = memoryStorage();
    vi.spyOn(storage, 'getItem').mockRejectedValue(failed);
    const onBackgroundError = vi.fn(() => {
      if (throws === 'async') return Promise.reject(new Error('handler failed'));
      if (throws) throw new Error('handler failed');
    });
    const nelcota = createClient('https://api.example.com', { auth: { storage, autoRefresh: true, onBackgroundError } });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed);
      expect(vi.getTimerCount()).toBe(0);
      await expect(nelcota.auth.getSession()).rejects.toBe(failed);
    } finally { nelcota.dispose(); vi.useRealTimers(); }
  });

  it('pauses on a failed background write and resumes with the replacement token', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    let channel!: { onmessage?: (event: { data: string }) => void };
    vi.stubGlobal('BroadcastChannel', class {
      onmessage?: (event: { data: string }) => void;
      constructor() { channel = this; }
      close() {}
      postMessage() {}
    });
    const storage = stored(session(120));
    const failed = new Error('storage unavailable');
    vi.spyOn(storage, 'setItem').mockRejectedValueOnce(failed);
    const onBackgroundError = vi.fn();
    const mock = mockFetch(json(session(900, 'refresh-2', 'access-2')), json(session(900, 'refresh-3', 'access-3')));
    const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, auth: { storage, autoRefresh: true, onBackgroundError } });
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed);
      expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('refresh-2');
      expect(vi.getTimerCount()).toBe(0);
      channel.onmessage?.({ data: 'changed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await nelcota.auth.refreshSession();
      expect(JSON.parse(mock.calls[1]!.body!).refresh_token).toBe('refresh-2');
      expect(vi.getTimerCount()).toBe(1);
    } finally { nelcota.dispose(); vi.useRealTimers(); }
  });

  it('observes a failed reload from another tab even without auto-refresh', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    let channel!: { onmessage?: (event: { data: string }) => void };
    vi.stubGlobal('BroadcastChannel', class {
      onmessage?: (event: { data: string }) => void;
      constructor() { channel = this; }
      close() {}
      postMessage() {}
    });
    const storage = stored(session());
    const failed = new Error('storage unavailable');
    const onBackgroundError = vi.fn();
    const nelcota = createClient('https://api.example.com', { auth: { storage, autoRefresh: false, onBackgroundError } });
    try {
      await nelcota.auth.getSession();
      vi.spyOn(storage, 'getItem').mockRejectedValueOnce(failed);
      channel.onmessage?.({ data: 'changed' });
      await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed));
    } finally { nelcota.dispose(); }
  });
});

describe('sign-out and user', () => {
  it('never reuses a spent refresh token after persistence fails', async () => {
    const storage = stored(session(30));
    const failed = new Error('storage unavailable');
    const setItem = vi.spyOn(storage, 'setItem').mockRejectedValueOnce(failed);
    const { nelcota, calls } = setup(storage,
      json(session(900, 'refresh-2', 'access-2')),
      json(session(900, 'refresh-3', 'access-3')),
    );
    try {
      await expect(nelcota.auth.refreshSession()).rejects.toBe(failed);
      expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('refresh-2');
      await nelcota.auth.refreshSession();
      expect(JSON.parse(calls[1]!.body!).refresh_token).toBe('refresh-2');
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(JSON.parse((await storage.getItem(KEY))!).refresh_token).toBe('refresh-3');
    } finally { nelcota.dispose(); }
  });

  it('does not restore a revoked session after local deletion fails', async () => {
    const storage = stored(session());
    const failed = new Error('storage unavailable');
    vi.spyOn(storage, 'removeItem').mockRejectedValueOnce(failed);
    const { nelcota, calls } = setup(storage, empty());
    try {
      await expect(nelcota.auth.signOut()).rejects.toBe(failed);
      expect((await nelcota.auth.getSession()).data).toBeNull();
      expect((await nelcota.auth.refreshSession()).error?.code).toBe('session_missing');
      await nelcota.auth.signOut();
      expect(calls).toHaveLength(1);
      expect(await storage.getItem(KEY)).toBeNull();
    } finally { nelcota.dispose(); }
  });

  it('updateUser sends snake_case fields and stores the returned user', async () => {
    const changed = { ...session().user, user_metadata: { plan: 'pro' } };
    const { nelcota, calls, storage, events } = setup(stored(session()), json(changed));
    const result = await nelcota.auth.updateUser({ password: 'new-password-123', currentPassword: 'old', data: { plan: 'pro' } });
    expect(result.error).toBeNull();
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url.pathname).toBe('/auth/v1/user');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ password: 'new-password-123', current_password: 'old', data: { plan: 'pro' } });
    expect(JSON.parse((await storage.getItem(KEY))!).user.user_metadata).toEqual({ plan: 'pro' });
    expect(events).toEqual(['user_updated']);
  });

  it('updateUser without password or data is a usage error', async () => {
    const { nelcota, calls } = setup(stored(session()), empty());
    await expect(nelcota.auth.updateUser({ currentPassword: 'x' })).rejects.toThrow('password or data');
    expect(calls).toHaveLength(0);
  });

  it('does not restore a session when getUser completes after logout', async () => {
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const changed = { ...session().user, user_metadata: { name: 'changed' } };
    const { nelcota, storage, events } = setup(stored(session()), async request => {
      if (request.url.pathname !== '/auth/v1/user') return empty();
      started(); await wait; return json(changed);
    });
    const user = nelcota.auth.getUser();
    await begun;
    await nelcota.auth.signOut();
    finish(); await user;
    expect((await nelcota.auth.getSession()).data).toBeNull();
    expect(await storage.getItem(KEY)).toBeNull();
    expect(events).toEqual(['signed_out']);
  });

  it('keeps rotated tokens when an old user response has the same access token', async () => {
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const { nelcota, storage } = setup(stored(session()), async request => {
      if (request.url.pathname !== '/auth/v1/user') return json(session(900, 'refresh-2', 'access-1'));
      started(); await wait;
      return json({ ...session().user, user_metadata: { stale: true } });
    });
    const user = nelcota.auth.getUser();
    await begun;
    await nelcota.auth.refreshSession();
    finish(); await user;
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('refresh-2');
    expect(JSON.parse((await storage.getItem(KEY))!).user.user_metadata).toEqual({});
  });

  it('does not overwrite a different sign-in with an old user response', async () => {
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const newer = { ...session(900, 'refresh-2', 'access-2'), user: { ...session().user, id: 'u2' } };
    const { nelcota } = setup(stored(session()), async request => {
      if (request.url.pathname !== '/auth/v1/user') return json(newer);
      started(); await wait; return json({ ...session().user, user_metadata: { stale: true } });
    });
    const user = nelcota.auth.getUser();
    await begun;
    await nelcota.auth.signInWithPassword({ email: 'other@example.com', password: 'pw' });
    finish(); await user;
    expect((await nelcota.auth.getSession()).data).toEqual(newer);
  });

  it('serializes logout after a pending password sign-in', async () => {
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const { nelcota } = setup(memoryStorage(), async request => {
      if (request.url.pathname !== '/auth/v1/token') return empty();
      started(); await wait; return json(session());
    });
    const signingIn = nelcota.auth.signInWithPassword({ email: 'a@example.com', password: 'pw' });
    await begun;
    const signingOut = nelcota.auth.signOut();
    finish(); await Promise.all([signingIn, signingOut]);
    expect((await nelcota.auth.getSession()).data).toBeNull();
  });

  it('revokes on the server and forgets locally even when the server fails', async () => {
    const ok = setup(stored(session()), empty(204));
    expect((await ok.nelcota.auth.signOut()).error).toBeNull();
    expect(ok.calls[0]!.url.pathname).toBe('/auth/v1/logout');
    expect(ok.calls[0]!.headers.get('authorization')).toBe('Bearer access-1');
    expect(await ok.storage.getItem(KEY)).toBeNull();
    expect(ok.events).toEqual(['signed_out']);

    const down = setup(stored(session()), json({ code: 'unavailable', message: 'down' }, 503));
    expect((await down.nelcota.auth.signOut()).error?.code).toBe('unavailable');
    expect(await down.storage.getItem(KEY)).toBeNull();
  });

  it('getUser updates the stored user', async () => {
    const changed = { ...session().user, email_confirmed_at: '2026-02-01T00:00:00Z' };
    const { nelcota, events, storage } = setup(stored(session()), json(changed));
    expect((await nelcota.auth.getUser()).data).toEqual(changed);
    expect(events).toEqual(['user_updated']);
    expect(JSON.parse((await storage.getItem(KEY))!).user.email_confirmed_at).toBe('2026-02-01T00:00:00Z');
    expect((await setup().nelcota.auth.getUser()).error?.code).toBe('session_missing');
  });
});

describe('OAuth with PKCE', () => {
  it('cannot erase a new OAuth verifier while consuming the previous callback', async () => {
    const stored = memoryStorage();
    await stored.setItem(`${KEY}.pkce`, 'v'.repeat(64));
    let reading = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const storage: SessionStorage = {
      ...stored,
      async getItem(key) {
        const value = await stored.getItem(key);
        if (key === `${KEY}.pkce` && !reading) { reading = true; await gate; }
        return value;
      },
    };
    const first = setup(storage, json(session())).nelcota, second = setup(storage).nelcota;
    try {
      const callback = first.auth.exchangeCode('old-code');
      await vi.waitFor(() => expect(reading).toBe(true));
      const login = second.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/back', redirect: false });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      release();
      const [exchanged, started] = await Promise.all([callback, login]);
      expect(exchanged.error).toBeNull();
      const verifier = await stored.getItem(`${KEY}.pkce`);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(new URL(started.data!.url).searchParams.get('code_challenge')).toBe(await challengeFor(verifier!));
    } finally { release(); first.dispose(); second.dispose(); }
  });

  it('keeps navigation ordered with verifier publication across clients', async () => {
    const storage = memoryStorage();
    const first = setup(storage).nelcota, second = setup(storage).nelcota;
    const navigations: string[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('location', { assign: (url: string) => navigations.push(url) });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let digests = 0;
    const original = globalThis.crypto;
    const digest = vi.fn(async () => {
      const number = ++digests;
      if (number === 1) await gate;
      return new Uint8Array(32).fill(number).buffer;
    });
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original), subtle: { digest } });
    try {
      const a = first.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/back' });
      await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
      const b = second.auth.signInWithOAuth({ provider: 'google', redirectTo: 'https://app.example.com/back' });
      // Flush the second call's microtasks while the first digest is suspended.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      release();
      await Promise.all([a, b]);
      expect(navigations.map(url => new URL(url).searchParams.get('provider'))).toEqual(['github', 'google']);
      expect(new URL(navigations.at(-1)!).searchParams.get('code_challenge'))
        .toBe(Buffer.from(new Uint8Array(32).fill(2)).toString('base64url'));
    } finally { release(); first.dispose(); second.dispose(); }
  });

  it('builds the authorize URL with an S256 challenge of a stored verifier', async () => {
    const { nelcota, storage } = setup();
    const { data } = await nelcota.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://app.example.com/back' });
    const url = new URL(data!.url);
    expect(url.origin + url.pathname).toBe('https://api.example.com/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('github');
    expect(url.searchParams.get('redirect_to')).toBe('https://app.example.com/back');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const verifier = (await storage.getItem(`${KEY}.pkce`))!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(url.searchParams.get('code_challenge')).toBe(await challengeFor(verifier));
  });

  it('exchanges the code once with the verifier, then forgets the verifier', async () => {
    const { nelcota, calls, storage } = setup(memoryStorage(), json(session()));
    await storage.setItem(`${KEY}.pkce`, 'v'.repeat(64));
    const { data } = await nelcota.auth.handleRedirect('https://app.example.com/back?code=abc&x=1');
    expect(data?.access_token).toBe('access-1');
    expect(calls[0]!.url.search).toBe('?grant_type=pkce');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ auth_code: 'abc', code_verifier: 'v'.repeat(64) });
    expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();
    expect((await nelcota.auth.exchangeCode('abc')).error?.code).toBe('pkce_missing');
  });

  it('refuses a relative redirectTo and tolerates a missing page URL', async () => {
    const { nelcota } = setup();
    await expect(nelcota.auth.signInWithOAuth({ provider: 'google', redirectTo: '/back' })).rejects.toThrow(NelcotaUsageError);
    // Outside a browser there is no location: nothing to handle.
    expect(await nelcota.auth.handleRedirect()).toEqual({ data: null, error: null });
    expect(nelcota.auth.readEmailLink()).toBeNull();
  });

  it('reports provider errors and ignores unrelated URLs', async () => {
    const { nelcota, calls } = setup();
    expect((await nelcota.auth.handleRedirect('https://app.example.com/back?error=access_denied')).error?.code).toBe('access_denied');
    expect(await nelcota.auth.handleRedirect('https://app.example.com/other')).toEqual({ data: null, error: null });
    expect(calls).toHaveLength(0);
  });

  it('the S256 challenge is base64url(SHA-256(verifier)) without padding', async () => {
    const { createHash } = await import('node:crypto');
    for (const verifier of ['a'.repeat(43), 'dBjftJeZ4CVP-mJ92K-1yLtDy1Y-ry9Lm1uTJ3mMkI8', 'x_~.-'.repeat(20)]) {
      expect(await challengeFor(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
    }
  });
});

describe('email links', () => {
  it('reads the fragment and cleans the address bar of the current page', () => {
    const href = 'https://app.example.com/new-password#type=recovery&token=tok_123';
    const replaceState = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('location', { href });
    vi.stubGlobal('history', { state: null, replaceState });
    const { nelcota } = setup();
    expect(nelcota.auth.readEmailLink()).toEqual({ type: 'recovery', token: 'tok_123' });
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://app.example.com/new-password');
  });

  it('ignores fragments that are not email links', () => {
    const { nelcota } = setup();
    for (const href of ['https://a.com/#type=admin&token=x', 'https://a.com/#token=x', `https://a.com/#type=signup&token=${'x'.repeat(129)}`]) {
      expect(nelcota.auth.readEmailLink(href), href).toBeNull();
    }
  });

  it('verifies links and resets passwords', async () => {
    const { nelcota, calls } = setup(memoryStorage(), json(session()));
    await nelcota.auth.verifyEmailLink({ type: 'magiclink', token: 't1' });
    await nelcota.auth.resetPassword({ token: 't2', password: 'new-password' });
    expect(calls.map((c) => JSON.parse(c.body!))).toEqual([
      { type: 'magiclink', token: 't1' },
      { type: 'recovery', token: 't2', password: 'new-password' },
    ]);
  });

  it('asks for emails without revealing whether the account exists', async () => {
    const { nelcota, calls } = setup(memoryStorage(), json({}));
    expect(await nelcota.auth.requestPasswordReset('a@x.com')).toEqual({ data: null, error: null });
    await nelcota.auth.sendMagicLink('a@x.com');
    await nelcota.auth.resendConfirmation('a@x.com');
    expect(calls.map((c) => [c.url.pathname, JSON.parse(c.body!)])).toEqual([
      ['/auth/v1/recover', { email: 'a@x.com' }],
      ['/auth/v1/magiclink', { email: 'a@x.com' }],
      ['/auth/v1/resend', { type: 'signup', email: 'a@x.com' }],
    ]);
  });
});
