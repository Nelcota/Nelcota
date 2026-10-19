import { describe, expect, it } from 'vitest';
import { createClient, escapeLike, NelcotaUsageError, unwrap } from '../../src/index.js';
import { countFromRange, rangeFromHeader } from '../../src/rest/query.js';
import { empty, json, mockFetch } from './helpers.js';

function client(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  const nelcota = createClient('https://api.example.com/', { fetch: mock.fetch, auth: { autoRefresh: false } });
  return { nelcota, calls: mock.calls };
}

const query = (url: URL) => [...url.searchParams.entries()];

describe('reads', () => {
  it('sends one GET with the filters, order and paging', async () => {
    const { nelcota, calls } = client(json([{ id: 1 }], 200, { 'content-range': '0-0/1' }));
    const { data, error, count, status } = await nelcota
      .from('todos')
      .select('id, title, owner:users(email)', { count: 'exact' })
      .eq('done', false)
      .in('priority', ['high', 'a,"b"'])
      .ilike('title', `*${escapeLike('50%')}*`)
      .is('deleted_at', null)
      .not('status', 'eq', 'cancelled')
      .gte('orders.total', 5)
      .order('id', { ascending: false, nullsFirst: false })
      .order('title')
      .order('qty', { referencedTable: 'orders' })
      .range(20, 39)
      .limit(2, { referencedTable: 'orders' });
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
    expect(count).toBe(1);
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('GET');
    expect(call!.url.pathname).toBe('/rest/v1/todos');
    expect(call!.headers.get('prefer')).toBe('count=exact');
    expect(query(call!.url)).toEqual([
      ['select', 'id,title,owner:users(email)'],
      ['done', 'eq.false'],
      ['priority', 'in.("high","a,\\"b\\"")'],
      ['title', 'ilike.*50\\%*'],
      ['deleted_at', 'is.null'],
      ['status', 'not.eq.cancelled'],
      ['orders.total', 'gte.5'],
      ['order', 'id.desc.nullslast,title.asc'],
      ['orders.order', 'qty.asc'],
      ['offset', '20'],
      ['limit', '20'],
      ['orders.limit', '2'],
    ]);
  });

  it('builds or/and groups from typed conditions', async () => {
    const { nelcota, calls } = client(json([]));
    await nelcota
      .from('products')
      .select()
      .or((c) => [c.eq('name', 'Ruler, 30cm'), c.and([c.gt('price', 100), c.not(c.is('featured', true))])])
      .or((c) => [c.eq('qty', 1)], { referencedTable: 'items' });
    expect(query(calls[0]!.url)).toEqual([
      ['select', '*'],
      ['or', '(name.eq."Ruler, 30cm",and(price.gt."100",featured.not.is.true))'],
      ['items.or', '(qty.eq."1")'],
    ]);
  });

  it('keeps builders immutable, so a base query can be reused', async () => {
    const { nelcota, calls } = client(json([]));
    const base = nelcota.from('todos').select('id').eq('done', false);
    await base.eq('id', 1);
    await base.eq('id', 2);
    expect(query(calls[0]!.url)).toEqual([['select', 'id'], ['done', 'eq.false'], ['id', 'eq.1']]);
    expect(query(calls[1]!.url)).toEqual([['select', 'id'], ['done', 'eq.false'], ['id', 'eq.2']]);
  });

  it('single asks for two rows at most and checks there is exactly one', async () => {
    const one = client(json([{ id: 1 }]));
    expect((await one.nelcota.from('todos').select().eq('id', 1).single()).data).toEqual({ id: 1 });
    expect(one.calls[0]!.url.searchParams.get('limit')).toBe('2');

    const many = client(json([{ id: 1 }, { id: 2 }]));
    const result = await many.nelcota.from('todos').select().single();
    expect(result.error?.code).toBe('not_single');
    expect(result.error?.message).toContain('more than one');

    const none = client(json([]));
    expect((await none.nelcota.from('todos').select().maybeSingle()).data).toBeNull();
    expect((await none.nelcota.from('todos').select().single()).error?.code).toBe('not_single');
  });

  it('head counts without rows', async () => {
    const { nelcota, calls } = client(empty(200, { 'content-range': '*/137' }));
    const { data, count } = await nelcota.from('todos').select('*', { count: 'exact', head: true });
    expect(calls[0]!.method).toBe('HEAD');
    expect(data).toBeNull();
    expect(count).toBe(137);
  });

  it('refuses cardinality on minimal writes and HEAD before sending', () => {
    const { nelcota, calls } = client(empty());
    const minimal = nelcota.from('todos').insert({ title: 'a' });
    // @ts-expect-error minimal writes do not have a row representation
    expect(() => minimal.single()).toThrow(NelcotaUsageError);
    // @ts-expect-error minimal writes do not have a row representation
    expect(() => minimal.maybeSingle()).toThrow(NelcotaUsageError);
    const head = nelcota.from('todos').select('*', { head: true }).select('id');
    // @ts-expect-error HEAD never returns rows, even after another select
    expect(() => head.single()).toThrow(NelcotaUsageError);
    // @ts-expect-error HEAD never returns rows
    expect(() => head.maybeSingle()).toThrow(NelcotaUsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects empty or non-array representations instead of returning typed rows', async () => {
    for (const response of [empty(200), json({ id: 1 }), json(null)]) {
      const { nelcota } = client(response);
      expect((await nelcota.from('todos').select()).error?.code).toBe('invalid_response');
      expect((await nelcota.from('todos').select().single()).error?.code).toBe('invalid_response');
    }
  });

  it('reads totals from Content-Range', () => {
    expect(countFromRange('0-19/137')).toBe(137);
    expect(countFromRange('0-19/*')).toBeNull();
    expect(countFromRange('*/0')).toBe(0);
    expect(countFromRange(null)).toBeNull();
    expect(rangeFromHeader('20-39/137')).toEqual({ from: 20, to: 39 });
    expect(rangeFromHeader('0-0/*')).toEqual({ from: 0, to: 0 });
    expect(rangeFromHeader('*/0')).toBeNull();
    expect(rangeFromHeader(null)).toBeNull();
  });

  it.each(['0-0/-1', '0-0/+1', '0-0/0x10', '0-0/1e2', '0-0/1.5', '0-0/1/2',
    '0-0/9007199254740992', 'garbage/12', '0-0/ 12'])('ignores invalid totals in %s', header => {
    expect(countFromRange(header)).toBeNull();
  });

  it('keeps runtime cardinality when reselecting singular queries', async () => {
    const { nelcota } = client(json([{ id: 1 }]));
    try {
      expect((await nelcota.from('todos').select().single().select('id')).data).toEqual({ id: 1 });
      const empty = client(json([]));
      try { expect((await empty.nelcota.from('todos').select().maybeSingle().select('id')).data).toBeNull(); }
      finally { empty.nelcota.dispose(); }
    } finally { nelcota.dispose(); }
  });

  it('exposes the returned range so truncation is visible', async () => {
    const { nelcota, calls } = client(json([{ id: 1 }, { id: 2 }], 200, { 'content-range': '10-11/40' }));
    const result = await nelcota.from('todos').select('id', { count: 'exact' }).limit(2).offset(10);
    expect(result).toMatchObject({ count: 40, range: { from: 10, to: 11 } });
    expect(query(calls[0]!.url)).toEqual([['select', 'id'], ['limit', '2'], ['offset', '10']]);
    expect(nelcota.from('todos').select().offset(3).offset(5).toString()).toBe('select=*&offset=5');
    expect(nelcota.from('todos').select().offset(2, { referencedTable: 'items' }).toString()).toBe('select=*&items.offset=2');
    expect(() => nelcota.from('todos').select().offset(-1)).toThrow(NelcotaUsageError);
    expect((await client(empty(201)).nelcota.from('todos').insert({ id: 1 })).range).toBeNull();
  });

  it('pages through every row until an empty page', async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
    const { nelcota, calls } = client(() => json(pages.shift()));
    const seen: unknown[] = [];
    for await (const page of nelcota.from('todos').select('id').order('id').offset(4).pages(2)) seen.push(page);
    expect(seen).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
    // A short page does not end the walk: the server may cap pages below `size`.
    expect(calls.map((c) => [c.url.searchParams.get('offset'), c.url.searchParams.get('limit')])).toEqual([['4', '2'], ['6', '2'], ['7', '2']]);
  });

  it('throwOnError() throws the error and keeps successes as results', async () => {
    const failing = client(json({ code: 'db_error', message: 'nope', sqlstate: '42501' }, 403));
    await expect(failing.nelcota.from('todos').select().throwOnError()).rejects.toMatchObject({ name: 'NelcotaError', code: 'db_error', sqlstate: '42501' });
    await expect(failing.nelcota.from('todos').select().throwOnError().execute()).rejects.toMatchObject({ status: 403 });

    const { nelcota } = client(json([{ id: 1 }], 200, { 'content-range': '0-0/*' }));
    const { data, error } = await nelcota.from('todos').select('id').throwOnError().eq('id', 1);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
    await expect(nelcota.from('todos').select('id').throwOnError().single()).resolves.toMatchObject({ data: { id: 1 } });

    const many = client(json([{ id: 1 }, { id: 2 }]));
    await expect(many.nelcota.from('todos').select().single().throwOnError()).rejects.toMatchObject({ code: 'not_single' });
  });

  it('unwrap() returns the data or throws the error', async () => {
    const { nelcota } = client(json([{ id: 1 }]));
    expect(unwrap(await nelcota.from('todos').select())).toEqual([{ id: 1 }]);
    const failing = client(json({ code: 'invalid_credentials', message: 'no' }, 400));
    const result = await failing.nelcota.auth.signInWithPassword({ email: 'a@x.com', password: 'pw' });
    expect(() => unwrap(result)).toThrow(expect.objectContaining({ code: 'invalid_credentials' }));
  });

  it('throws page errors and refuses pages() outside reads', async () => {
    const { nelcota } = client(json({ code: 'rate_limited', message: 'slow down' }, 400));
    await expect(async () => {
      for await (const _ of nelcota.from('todos').select().pages(10)) void _;
    }).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(nelcota.from('todos').select().pages(0).next()).rejects.toThrow(NelcotaUsageError);
    const head = nelcota.from('todos').select('*', { head: true }) as unknown as { pages(size: number): AsyncGenerator };
    await expect(head.pages(1).next()).rejects.toThrow(NelcotaUsageError);
  });

  it('returns server errors as values', async () => {
    const { nelcota } = client(json({ code: 'db_error', message: 'permission denied for table secrets (42501)' }, 401));
    const { data, error, status } = await nelcota.from('secrets').select();
    expect(data).toBeNull();
    expect(status).toBe(401);
    expect(error).toMatchObject({ name: 'NelcotaError', status: 401, code: 'db_error' });
  });

  it('refuses unsafe identifiers before sending', () => {
    const { nelcota, calls } = client(json([]));
    expect(() => nelcota.from('pg_catalog.pg_authid')).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').select().eq('id;drop' as 'id', 1)).not.toThrow();
    expect(() => nelcota.from('todos').select().eq('a,b' as 'id', 1)).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').select('id"')).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').select().order('id.desc' as 'id')).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').select().limit(-1)).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').select().range(5, 4)).toThrow(NelcotaUsageError);
    expect(calls).toHaveLength(0);
  });
});

describe('writes', () => {
  it('insert sends rows with return=minimal, select() asks for them back', async () => {
    const { nelcota, calls } = client(empty(201), json([{ id: 1, title: 'a' }], 201));
    expect((await nelcota.from('todos').insert([{ title: 'a' }, { title: 'b' }])).data).toBeNull();
    expect(calls[0]!.headers.get('prefer')).toBe('return=minimal');
    expect(calls[0]!.body).toBe('[{"title":"a"},{"title":"b"}]');

    const { data } = await nelcota.from('todos').insert({ title: 'a' }).select('id,title').single();
    expect(data).toEqual({ id: 1, title: 'a' });
    expect(calls[1]!.headers.get('prefer')).toBe('return=representation');
    expect(query(calls[1]!.url)).toEqual([['select', 'id,title']]);
  });

  it('upsert names the conflict columns and the resolution', async () => {
    const { nelcota, calls } = client(empty(201));
    await nelcota.from('products').upsert({ slug: 'pen' }, { onConflict: ['slug', 'shop'], ignoreDuplicates: true });
    expect(query(calls[0]!.url)).toEqual([['on_conflict', 'slug,shop']]);
    expect(calls[0]!.headers.get('prefer')).toBe('return=minimal,resolution=ignore-duplicates');
  });

  it('update and delete carry their filters', async () => {
    const { nelcota, calls } = client(empty(204));
    await nelcota.from('todos').update({ done: true }).eq('id', 3);
    await nelcota.from('todos').delete().in('id', [1, 2]);
    expect(calls.map((c) => [c.method, c.url.search])).toEqual([
      ['PATCH', '?id=eq.3'],
      ['DELETE', '?id=in.%28%221%22%2C%222%22%29'],
    ]);
    expect(calls[0]!.body).toBe('{"done":true}');
  });

  it('refuses malformed writes before sending', () => {
    const { nelcota } = client(empty());
    expect(() => nelcota.from('todos').insert([])).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').update([] as never)).toThrow(NelcotaUsageError);
    expect(() => nelcota.from('todos').upsert({}, { onConflict: 'a b' })).toThrow(NelcotaUsageError);
  });
});

describe('rpc', () => {
  it('posts named arguments and reads the result', async () => {
    const { nelcota, calls } = client(json(12), empty(204));
    expect(await nelcota.rpc('add', { a: 2 })).toEqual({ data: 12, error: null, status: 200 });
    expect(calls[0]!.url.pathname).toBe('/rest/v1/rpc/add');
    expect(calls[0]!.body).toBe('{"a":2}');
    expect((await nelcota.rpc('nothing')).data).toBeNull();
    expect(calls[1]!.body).toBe('{}');
  });
});
