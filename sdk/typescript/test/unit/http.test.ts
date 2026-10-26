import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, NelcotaUsageError } from '../../src/index.js';
import { baseUrl, errorFromResponse, parseRetryAfter } from '../../src/core/http.js';
import { assertTokenAllowed } from '../../src/core/jwt.js';
import { empty, json, jwt, mockFetch, session } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('JSON input boundaries', () => {
  it.each([NaN, Infinity, -Infinity, new Number(NaN)])('rejects non-finite writes and RPC input before auth or HTTP (%s)', async value => {
    const mock = mockFetch();
    const token = vi.fn(() => null);
    const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, accessToken: token, auth: { autoRefresh: false } });
    try {
      for (const query of [
        nelcota.from('notes').insert({ nested: { values: [value] } }),
        nelcota.from('notes').update({ value }),
        nelcota.from('notes').upsert({ value }),
      ]) await expect(query.execute()).rejects.toBeInstanceOf(NelcotaUsageError);
      await expect(nelcota.rpc('echo', { value })).rejects.toBeInstanceOf(NelcotaUsageError);
      expect(mock.calls).toHaveLength(0);
      expect(token).not.toHaveBeenCalled();
    } finally { nelcota.dispose(); }
  });

  it('preserves explicit nulls and finite numbers in writes and RPC', async () => {
    const mock = mockFetch(empty(), json(null));
    const nelcota = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
    const input = { value: null, nested: [1.25, null], label: 'NaN' };
    try {
      expect((await nelcota.from('notes').insert(input)).error).toBeNull();
      expect((await nelcota.rpc('echo', input)).error).toBeNull();
      expect(mock.calls.map(call => JSON.parse(call.body!))).toEqual([input, input]);
    } finally { nelcota.dispose(); }
  });
});

describe('error response budgets', () => {
  it.each([undefined, '1', '1000000'])('cancels oversized error pages with length %s', async length => {
    const cancel = vi.fn();
    let chunks = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (chunks++ === 10) { controller.close(); return; }
      controller.enqueue(new Uint8Array(8192));
    });
    const headers = new Headers({ 'retry-after': '90' });
    if (length !== undefined) headers.set('content-length', length);
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const error = await errorFromResponse(new Response(body, { status: 503, headers }));
    expect(error).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 90 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBe(length === '1000000' ? 0 : 9);
    expect(body.locked).toBe(false);
  });

  it('decodes a complete error at the exact byte boundary', async () => {
    const text = JSON.stringify({ code: 'db_error', message: 'ação' });
    const data = new TextEncoder().encode(text + ' '.repeat(65536 - new TextEncoder().encode(text).length));
    const body = new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
    expect(await errorFromResponse(new Response(body, { status: 409 }))).toMatchObject({ status: 409, code: 'db_error', message: 'ação' });
  });
});

function client(mock: ReturnType<typeof mockFetch>, options: Parameters<typeof createClient>[1] = {}) {
  return createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false }, ...options });
}

it('keeps an unsafe identifier intact when it is reused in a filter', async () => {
  const mock = mockFetch(new Response('[{"id":9007199254740993}]'), json([]));
  const nelcota = client(mock);
  const first = await nelcota.from('todos').select('id');
  expect(first.data).toEqual([{ id: '9007199254740993' }]);
  await nelcota.from('todos').select('id').eq('id', first.data![0]!.id);
  expect(mock.calls[1]!.url.searchParams.get('id')).toBe('eq.9007199254740993');
});

describe('retries', () => {
  it('returns long Retry-After delays instead of retrying too early', async () => {
    const mock = mockFetch(json({ code: 'rate_limited', message: 'wait' }, 429, { 'retry-after': '90' }));
    expect((await client(mock).from('todos').select()).error?.retryAfter).toBe(90);
    expect(mock.calls).toHaveLength(1);
  });
  it('retries reads on 429 honouring Retry-After', async () => {
    vi.useFakeTimers();
    const mock = mockFetch(json({ code: 'rate_limited', message: 'slow down' }, 429, { 'retry-after': '2' }), json([]));
    const pending = client(mock).from('todos').select().execute();
    await vi.advanceTimersByTimeAsync(1999);
    expect(mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const { data, error } = await pending;
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(mock.calls).toHaveLength(2);
  });

  it('gives up after the configured retries and reports retryAfter', async () => {
    const mock = mockFetch(json({ code: 'rate_limited', message: 'slow down' }, 429, { 'retry-after': '0' }));
    const { error } = await client(mock, { retries: 1 }).from('todos').select();
    expect(mock.calls).toHaveLength(2);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 0 });
  });

  it('never retries writes', async () => {
    const mock = mockFetch(json({ code: 'unavailable', message: 'down' }, 503, { 'retry-after': '0' }));
    const { error } = await client(mock).from('todos').insert({ title: 'x' });
    expect(mock.calls).toHaveLength(1);
    expect(error?.code).toBe('unavailable');
  });

  it('retries reads after network errors, not after 4xx', async () => {
    let attempts = 0;
    const mock = mockFetch(() => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return json({ code: 'invalid_query', message: 'bad' }, 400);
    });
    const { error } = await client(mock).from('todos').select();
    expect(attempts).toBe(2);
    expect(error?.code).toBe('invalid_query');
  });

  it('parses both Retry-After forms', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThanOrEqual(2);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('failures without a response', () => {
  it('cancels while waiting for a caller token without sending HTTP', async () => {
    let started!: () => void, finish!: (token: string) => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const token = new Promise<string>(resolve => { finish = resolve; });
    const mock = mockFetch(json([]));
    const nelcota = client(mock, { accessToken: () => { started(); return token; } });
    const controller = new AbortController();
    const pending = nelcota.from('todos').select().abortSignal(controller.signal).execute();
    await begun;
    try {
      controller.abort();
      expect((await pending).error?.code).toBe('aborted');
      expect(mock.calls).toHaveLength(0);
    } finally { finish('late-token'); nelcota.dispose(); }
  });

  it('cancels a query independently of the shared session refresh', async () => {
    vi.useFakeTimers();
    let started!: () => void, finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    let requests = 0;
    const nelcota = createClient('https://api.example.com', {
      auth: { autoRefresh: false },
      fetch: async () => { requests++; started(); await wait; return json(session(900, 'refresh-2', 'access-2')); },
    });
    await nelcota.auth.setSession(session(30));
    const controller = new AbortController();
    let code: string | undefined;
    const pending = nelcota.from('todos').select().abortSignal(controller.signal).execute()
      .then(result => { code = result.error?.code; });
    await begun;
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(code).toBe('aborted');
      expect(requests).toBe(1);
    } finally {
      finish(); await pending;
      expect((await nelcota.auth.getSession()).data?.refresh_token).toBe('refresh-2');
      nelcota.dispose(); vi.useRealTimers();
    }
  });

  it('preserves token adapter exceptions and observes late failures after cancellation', async () => {
    const mock = mockFetch(json([]));
    const failure = new Error('adapter failed');
    const broken = client(mock, { accessToken: async () => { throw failure; } });
    await expect(broken.from('todos').select().execute()).rejects.toBe(failure);
    let rejectToken!: (error: Error) => void, started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const token = new Promise<string>((_resolve, reject) => { rejectToken = reject; });
    const detached = client(mock, { accessToken: () => { started(); return token; } });
    const controller = new AbortController();
    const pending = detached.from('todos').select().abortSignal(controller.signal).execute();
    await begun; controller.abort();
    expect((await pending).error?.code).toBe('aborted');
    rejectToken(failure);
    await Promise.resolve();
    expect(mock.calls).toHaveLength(0);
    broken.dispose(); detached.dispose();
  });

  it('returns errors for truncated JSON and file bodies and retries only reads', async () => {
    const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection lost')); } }));
    const read = mockFetch(broken, json([]));
    expect((await client(read).from('t').select()).error).toBeNull();
    expect(read.calls).toHaveLength(2);
    const write = mockFetch(broken);
    expect((await client(write).from('t').insert({ a: 1 })).error?.code).toBe('network_error');
    expect(write.calls).toHaveLength(1);
    const file = mockFetch(broken);
    expect((await client(file, { retries: 0 }).storage.from('files').download('a.txt')).error?.code).toBe('network_error');
  });

  it('classifies abort and timeout while reading a response body', async () => {
    const fetchBody = async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    }));
    const timed = createClient('https://api.example.com', { fetch: fetchBody, timeout: 15, retries: 0 });
    expect((await timed.from('t').select()).error?.code).toBe('timeout');
    const controller = new AbortController();
    const aborted = createClient('https://api.example.com', { fetch: fetchBody, retries: 0 });
    const download = aborted.storage.from('files').download('a.txt', { signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    expect((await download).error?.code).toBe('aborted');
  });

  it('refuses invalid timeout and retry settings before sending', async () => {
    const mock = mockFetch(json([]));
    for (const options of [{ timeout: -1 }, { timeout: Infinity }, { retries: -1 }, { retries: 1.5 }]) {
      expect(() => client(mock, options)).toThrow(NelcotaUsageError);
    }
    await expect(client(mock).from('t').select().timeout(NaN).execute()).rejects.toBeInstanceOf(NelcotaUsageError);
    expect(mock.calls).toHaveLength(0);
  });
  it('reports network errors, timeouts and aborts with client codes', async () => {
    const down = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect((await client(down, { retries: 0 }).from('t').select()).error).toMatchObject({ status: 0, code: 'network_error' });

    const hanging = mockFetch(
      (request) =>
        new Promise<Response>((_, reject) => {
          void request;
          setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), 20);
        }),
    );
    expect((await client(hanging, { retries: 0, timeout: 10 }).from('t').select()).error?.code).toBe('timeout');

    const controller = new AbortController();
    controller.abort();
    const aborting = mockFetch(json([]));
    expect((await client(aborting).from('t').select().abortSignal(controller.signal)).error?.code).toBe('aborted');
  });

  it('keeps non-JSON error pages generic', async () => {
    const mock = mockFetch(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect((await client(mock).from('t').select()).error).toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' });
  });

  it('keeps a code for bodyless errors such as HEAD counts', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found']] as const) {
      const mock = mockFetch(empty(status));
      const { error } = await client(mock).from('t').select('*', { count: 'exact', head: true });
      expect(error).toMatchObject({ status, code });
    }
  });

  it('exposes the optional Postgres fields of a db_error', async () => {
    const body = {
      code: 'db_error',
      message: 'duplicate key value violates unique constraint "notes_title_key" (23505)',
      sqlstate: '23505',
      details: 'Key (title)=(a) already exists.',
      hint: 'Pick another title.',
      constraint: 'notes_title_key',
    };
    const { error } = await client(mockFetch(json(body, 409))).from('notes').insert({ title: 'a' });
    expect(error).toMatchObject({ status: 409, code: 'db_error', sqlstate: '23505', details: body.details, hint: body.hint, constraint: 'notes_title_key' });
    expect(error!.toJSON()).toEqual({ name: 'NelcotaError', status: 409, ...body });

    const old = await client(mockFetch(json({ code: 'db_error', message: 'boom' }, 400))).from('notes').insert({ title: 'a' });
    expect(old.error).toMatchObject({ sqlstate: undefined, details: undefined, hint: undefined, constraint: undefined });
    expect(Object.keys(old.error!.toJSON())).toEqual(['name', 'status', 'code', 'message']);
  });
});

describe('headers and tokens', () => {
  it('omits caller-configured authorization on public auth endpoints', async () => {
    const mock = mockFetch(json({ code: 'invalid_credentials', message: 'no' }, 400));
    await client(mock, { headers: { authorization: 'Bearer caller-token' } }).auth.signInWithPassword({ email: 'a@x.com', password: 'pw' });
    expect(mock.calls[0]!.headers.has('authorization')).toBe(false);
  });
  it('sends only the bearer token and the content type it needs', async () => {
    const mock = mockFetch(json([]));
    await client(mock, { accessToken: () => 'tok' }).from('t').insert({ a: 1 });
    const headers = [...mock.calls[0]!.headers.keys()].sort();
    expect(headers).toEqual(['authorization', 'content-type', 'prefer']);
    expect(mock.calls[0]!.headers.get('authorization')).toBe('Bearer tok');
  });

  it('sends no Authorization for visitors', async () => {
    const mock = mockFetch(json([]));
    await client(mock).from('t').select();
    expect(mock.calls[0]!.headers.has('authorization')).toBe(false);
  });

  it('refuses a service_role token in a browser, allows it on a server', () => {
    const token = jwt({ role: 'service_role' });
    expect(() => assertTokenAllowed(token, true)).toThrow(NelcotaUsageError);
    expect(() => assertTokenAllowed(token, false)).not.toThrow();
    expect(() => assertTokenAllowed(jwt({ role: 'authenticated' }), true)).not.toThrow();
  });

  it('refuses a service_role request when running in a browser', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    const mock = mockFetch(json([]));
    const nelcota = client(mock, { accessToken: () => jwt({ role: 'service_role', n: 1 }) });
    await expect(nelcota.from('t').select().execute()).rejects.toThrow(NelcotaUsageError);
    expect(mock.calls).toHaveLength(0);
  });

  it('validates the base URL', () => {
    expect(baseUrl('https://api.example.com/base/').href).toBe('https://api.example.com/base/');
    for (const url of ['ftp://x', 'not a url', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f']) {
      expect(() => baseUrl(url), url).toThrow(NelcotaUsageError);
    }
  });

  it('keeps a base path', async () => {
    const mock = mockFetch(json([]));
    await createClient('https://example.com/nelcota/', { fetch: mock.fetch }).from('t').select();
    expect(mock.calls[0]!.url.pathname).toBe('/nelcota/rest/v1/t');
  });

  it('never shows tokens when errors are logged', async () => {
    const mock = mockFetch(json({ code: 'invalid_token', message: 'expired' }, 401));
    const { error } = await client(mock, { accessToken: () => 'secret-token' }).from('t').select();
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(String(error)).not.toContain('secret-token');
  });
});


it('retains rate-limit delay when serializing an error without its cause', async () => {
  const mock = mockFetch(json({ code: 'rate_limited', message: 'Try later' }, 429, { 'retry-after': '17' }));
  const result = await client(mock, { retries: 0 }).from('notes').select();
  expect(JSON.parse(JSON.stringify(result.error))).toEqual({
    name: 'NelcotaError', status: 429, code: 'rate_limited', message: 'Try later', retryAfter: 17,
  });
});

describe('query strings', () => {
  it('keeps filters on engines without URLSearchParams.size (Safari < 17)', async () => {
    const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size');
    Object.defineProperty(URLSearchParams.prototype, 'size', { configurable: true, get: () => undefined });
    try {
      const mock = mockFetch(json([]));
      await createClient('https://api.example.com', { fetch: mock.fetch }).from('notes').select('id').eq('owner', 7);
      expect(String(mock.calls[0]?.url)).toContain('owner=eq.7');
    } finally {
      if (size) Object.defineProperty(URLSearchParams.prototype, 'size', size);
    }
  });
});
