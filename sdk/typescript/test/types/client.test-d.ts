import { describe, expectTypeOf, it } from 'vitest';
import { createClient, unwrap, type Bucket, type BucketSettings, type SelectError, type SelectOptions } from '../../src/index.js';
import type { Database, Json } from './database.js';

const nelcota = createClient<Database>('https://api.example.com');

it('exposes exact bucket limits in read and write types', () => {
  expectTypeOf<Bucket['file_size_limit']>().toEqualTypeOf<number | string | null>();
  expectTypeOf<BucketSettings['file_size_limit']>().toEqualTypeOf<number | string | null | undefined>();
});

type Result<Q> = Q extends PromiseLike<infer R> ? (R extends { data: infer D; error: null } ? D : never) : never;

describe('select', () => {
  it('types * as the full row', () => {
    const all = nelcota.from('orders').select();
    expectTypeOf<Result<typeof all>>().toEqualTypeOf<Database['public']['Tables']['orders']['Row'][]>();
    const star = nelcota.from('orders').select('*');
    expectTypeOf<Result<typeof star>>().toEqualTypeOf<Database['public']['Tables']['orders']['Row'][]>();
  });

  it('picks columns', () => {
    const query = nelcota.from('orders').select('id, status');
    expectTypeOf<Result<typeof query>>().toEqualTypeOf<{ id: number | string; status: 'open' | 'paid' | 'shipped' }[]>();
  });

  it('types many-to-one embeds as an object or null, one-to-many as arrays', () => {
    const query = nelcota.from('orders').select('id,buyer:customers!customer_id(name),items(product,qty)');
    expectTypeOf<Result<typeof query>>().toEqualTypeOf<
      { id: number | string; buyer: { name: string } | null; items: { product: string; qty: number }[] }[]
    >();
    const back = nelcota.from('customers').select('name,orders!customer_id(id,items(*))');
    expectTypeOf<Result<typeof back>>().toEqualTypeOf<
      { name: string; orders: { id: number | string; items: Database['public']['Tables']['items']['Row'][] }[] }[]
    >();
  });

  it('reports ambiguous embeds and unknown columns in the row type', () => {
    const ambiguous = nelcota.from('orders').select('customers(name)');
    expectTypeOf<Result<typeof ambiguous>[number]['customers']>().toMatchTypeOf<SelectError<string>>();
    const unknown = nelcota.from('orders').select('nope');
    expectTypeOf<Result<typeof unknown>[number]['nope']>().toMatchTypeOf<SelectError<string>>();
  });

  it('single and maybeSingle change the result to one row', () => {
    const one = nelcota.from('orders').select('id').eq('id', 1).single();
    expectTypeOf<Result<typeof one>>().toEqualTypeOf<{ id: number | string }>();
    const maybe = nelcota.from('orders').select('id').maybeSingle();
    expectTypeOf<Result<typeof maybe>>().toEqualTypeOf<{ id: number | string } | null>();
  });

  it('preserves cardinality when changing a projection', () => {
    const one = nelcota.from('orders').select().single().select('id');
    const maybe = nelcota.from('orders').select().maybeSingle().select('id');
    expectTypeOf<Result<typeof one>>().toEqualTypeOf<{ id: number | string }>();
    expectTypeOf<Result<typeof maybe>>().toEqualTypeOf<{ id: number | string } | null>();
    // @ts-expect-error a reselected single row cannot be paginated
    one.pages(10);
    // @ts-expect-error nullable rows cannot be paginated
    maybe.pages(10);
    const write = nelcota.from('customers').insert({ name: 'Ana' }).select('id');
    expectTypeOf<Result<typeof write>>().toEqualTypeOf<{ id: number | string }[]>();
  });

  it('types HEAD as null and preserves that through another select', () => {
    const head = nelcota.from('orders').select('id', { head: true });
    expectTypeOf<Result<typeof head>>().toEqualTypeOf<null>();
    const reselected = head.select('status');
    expectTypeOf<Result<typeof reselected>>().toEqualTypeOf<null>();
    // @ts-expect-error HEAD never returns a row
    head.single();
    // @ts-expect-error HEAD never returns a row
    reselected.maybeSingle();
    const withOptions = (options: SelectOptions) => nelcota.from('orders').select('id', options);
    expectTypeOf<Result<ReturnType<typeof withOptions>>>().toEqualTypeOf<{ id: number | string }[] | null>();
    const get = nelcota.from('orders').select('id', { head: false });
    expectTypeOf<Result<typeof get>>().toEqualTypeOf<{ id: number | string }[]>();
  });

  it('throwOnError drops the error branch and survives later calls', () => {
    const query = nelcota.from('orders').select('id').throwOnError().eq('id', 1).single();
    expectTypeOf<Awaited<typeof query>['data']>().toEqualTypeOf<{ id: number | string }>();
    expectTypeOf<Awaited<typeof query>['error']>().toEqualTypeOf<null>();
    expectTypeOf<Awaited<ReturnType<typeof query.execute>>['data']>().toEqualTypeOf<{ id: number | string }>();
    const plain = nelcota.from('orders').select('id');
    expectTypeOf<Awaited<typeof plain>['data']>().toEqualTypeOf<{ id: number | string }[] | null>();
    expectTypeOf(unwrap<{ id: number | string }[]>).returns.toEqualTypeOf<{ id: number | string }[]>();
    void nelcota.from('orders').select('id').throwOnError().pages(10);
  });

  it('pages yield arrays of the selected row, only on row reads', () => {
    const pages = nelcota.from('orders').select('id').order('id').offset(10).pages(100);
    expectTypeOf(pages).toEqualTypeOf<AsyncGenerator<{ id: number | string }[], void, undefined>>();
    // @ts-expect-error a HEAD read has no rows to page
    nelcota.from('orders').select('id', { head: true }).pages(100);
    // @ts-expect-error a single row has no pages
    nelcota.from('orders').select('id').single().pages(100);
  });
});

describe('filters', () => {
  it('checks columns and value types', () => {
    const orders = nelcota.from('orders').select();
    orders.eq('status', 'paid');
    orders.in('status', ['open', 'paid']);
    orders.gte('total', 10);
    orders.eq('id', '9007199254740993');
    orders.eq('id', 9007199254740993n);
    orders.match({ id: '9007199254740993', total: '0.1234567890123456789' });
    orders.or(c => [c.eq('id', '9007199254740993'), c.gt('total', 10)]);
    orders.eq('items.qty', 3);
    // @ts-expect-error not a status
    orders.eq('status', 'lost');
    // @ts-expect-error not a column
    orders.eq('nope', 1);
    // @ts-expect-error total is a numeric value
    orders.gt('total', true);
    orders.or((c) => [c.eq('status', 'paid'), c.gt('total', 100)]);
    // Columns that are not selected can still filter and order.
    nelcota.from('orders').select('id').eq('status', 'paid').order('total').or((c) => [c.gt('total', 1)]);
    // @ts-expect-error still a column of the table
    nelcota.from('orders').select('id').eq('nope', 1);
    // @ts-expect-error not a column
    orders.or((c) => [c.eq('nope', 1)]);
    // @ts-expect-error not a status
    orders.or((c) => [c.eq('status', 'lost')]);
  });
});

describe('writes', () => {
  it('takes Insert and Update shapes', () => {
    nelcota.from('orders').insert({ total: 10 });
    nelcota.from('orders').insert([{ total: 10, status: 'paid' }]);
    // @ts-expect-error total is required
    nelcota.from('orders').insert({ status: 'paid' });
    nelcota.from('orders').update({ status: 'shipped' }).eq('id', 1);
    // @ts-expect-error unknown column
    nelcota.from('orders').update({ nope: 1 });
    const meta: Json = { a: 1 };
    nelcota.from('orders').upsert({ total: 1, meta }, { onConflict: 'id' });
  });

  it('returns nothing unless select() asks for rows', () => {
    const minimal = nelcota.from('orders').insert({ total: 1 });
    expectTypeOf<Result<typeof minimal>>().toEqualTypeOf<null>();
    // @ts-expect-error select is required before single on a minimal write
    minimal.single();
    // @ts-expect-error select is required before maybeSingle on a minimal write
    minimal.maybeSingle();
    const back = nelcota.from('orders').insert({ total: 1 }).select('id').single();
    expectTypeOf<Result<typeof back>>().toEqualTypeOf<{ id: number | string }>();
  });

  it('views without Insert refuse writes', () => {
    // @ts-expect-error a materialized view has no Insert
    nelcota.from('order_totals').insert({ total: 1 });
  });
});

describe('rpc', () => {
  it('types arguments and results', async () => {
    expectTypeOf((await nelcota.rpc('add', { a: 1 })).data).toEqualTypeOf<number | null>();
    // @ts-expect-error a is required
    void nelcota.rpc('add', {});
    expectTypeOf((await nelcota.rpc('open_orders')).data).toEqualTypeOf<Database['public']['Tables']['orders']['Row'][] | null>();
    // @ts-expect-error unknown function
    void nelcota.rpc('nope');
  });
});

describe('untyped client', () => {
  it('works without a Database type', () => {
    const loose = createClient('https://api.example.com');
    const query = loose.from('anything').select('a,b(c)').eq('x', 1);
    expectTypeOf<Result<typeof query>>().toEqualTypeOf<Record<string, any>[]>();
    const one = loose.from('anything').select().single().select('id');
    const maybe = loose.from('anything').select().maybeSingle().select('id');
    expectTypeOf<Result<typeof one>>().toEqualTypeOf<Record<string, any>>();
    expectTypeOf<Result<typeof maybe>>().toEqualTypeOf<Record<string, any> | null>();
  });
});

describe('bucket settings', () => {
  it('requires every replacement setting but keeps creation defaults', () => {
    void nelcota.storage.createBucket('avatars', { public: true });
    void nelcota.storage.updateBucket('avatars', { public: true, file_size_limit: 1024, allowed_mime_types: ['image/png'] });
    void nelcota.storage.updateBucket('avatars', { public: false, file_size_limit: null, allowed_mime_types: null });
    // @ts-expect-error a replacement must explicitly keep or clear both limits
    void nelcota.storage.updateBucket('avatars', { public: true });
    // @ts-expect-error public must be explicit in a replacement
    void nelcota.storage.updateBucket('avatars', { file_size_limit: null, allowed_mime_types: null });
    // @ts-expect-error MIME settings must be explicit in a replacement
    void nelcota.storage.updateBucket('avatars', { public: true, file_size_limit: null });
  });
});
