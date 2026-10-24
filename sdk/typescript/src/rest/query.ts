/**
 * The query builder. Each call returns a new builder (a base query can be
 * reused safely), and awaiting it sends exactly one request.
 */

import { NelcotaError, NelcotaUsageError } from '../core/errors.js';
import { columnPath, identifier, inList, scalar, quote, type FilterScalar } from '../core/encoding.js';
import type { HttpClient } from '../core/http.js';
import { isRecord } from '../core/json.js';
import {
  Conditions,
  compareOperator,
  encodeGroup,
  isOperand,
  type CompareOperator,
  type Condition,
  type FilterValue,
  type IsValue,
} from './conditions.js';
import type { GenericSchema, Relation, RowOf, SelectRow } from './types.js';
import type { FilterColumn, OrderOptions, QueryOutcome, QueryResult, ReferencedOption, RowRange, SelectOptions, UpsertOptions } from './query-types.js';
export type { CountOption, FilterColumn, OrderOptions, QueryOutcome, QueryResult, QuerySuccess, ReferencedOption, RowRange, SelectOptions, UpsertOptions } from './query-types.js';

/** Filters and ordering use every column of the table, not only the selected ones. */
type TableRow<S extends GenericSchema, Name extends string> = RowOf<Relation<S, Name>>;

type ValueFor<Row, C> = C extends keyof Row ? FilterValue<Row[C]> : FilterScalar;

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'or', 'and', 'on_conflict', 'columns']);
type GroupRow<S extends GenericSchema, Name extends string, Options> = Options extends undefined ? TableRow<S, Name> : 'referencedTable' extends keyof Options ? Record<string, unknown> : TableRow<S, Name>;

type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';
type Cardinality = 'many' | 'one' | 'maybe';
type Reselected<Out, Row> = [Out] extends [null | readonly unknown[]] ? Row[] : null extends Out ? Row | null : Row;

interface State {
  readonly http: HttpClient;
  readonly table: string;
  readonly method: Method;
  readonly params: readonly (readonly [string, string])[];
  readonly prefer: readonly string[];
  readonly body?: unknown;
  readonly cardinality: Cardinality;
  readonly returnsRows: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
  readonly throws?: boolean;
}

function referenced(key: string, options: ReferencedOption | undefined): string {
  const table = options?.referencedTable;
  if (table === undefined) return key;
  return `${columnPath(table)}.${key}`;
}

/** Total rows from `Content-Range: 0-19/137` (`*` when not counted). */
export function countFromRange(header: string | null): number | null {
  const count = Number(header?.match(/^(?:\d+-\d+|\*)\/(\d+)$/)?.[1]);
  return Number.isSafeInteger(count) ? count : null;
}

/** Rows from `Content-Range: 0-19/137`; `null` for `*\/137` (no rows) or no header. */
export function rangeFromHeader(header: string | null): RowRange | null {
  const match = header?.match(/^(\d+)-(\d+)\//);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from ? { from, to } : null;
}

export class Query<S extends GenericSchema, Name extends string, Row, Out, Head extends boolean = false, Throws extends boolean = false>
  implements PromiseLike<QueryOutcome<Out, Throws>>
{
  readonly #state: State;

  /** @internal Use `client.from(table)`. */
  constructor(state: State) {
    this.#state = state;
  }

  #with(patch: Partial<State>): this {
    return new Query({ ...this.#state, ...patch }) as this;
  }

  #param(key: string, value: string): this {
    return this.#with({ params: [...this.#state.params, [key, value]] });
  }

  #filter(column: string, op: string, value: string): this {
    const parts = columnPath(column).split('.');
    const field = parts.pop()!;
    if (RESERVED.has(field)) {
      const operand = op.endsWith('in') || op.endsWith('is') ? value : quote(value);
      return this.#param([...parts, 'and'].join('.'), `(${field}.${op}.${operand})`);
    }
    return this.#param(column, `${op}.${value}`);
  }

  // ------------------------------------------------------------- filters

  eq<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'eq', scalar(value));
  }
  neq<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'neq', scalar(value));
  }
  gt<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'gt', scalar(value));
  }
  gte<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'gte', scalar(value));
  }
  lt<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'lt', scalar(value));
  }
  lte<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: ValueFor<TableRow<S, Name>, C>): this {
    return this.#filter(column, 'lte', scalar(value));
  }
  /** `*` (or `%`) matches any text. Wrap typed input in `escapeLike`. */
  like<C extends FilterColumn<TableRow<S, Name>>>(column: C, pattern: string): this {
    return this.#filter(column, 'like', scalar(pattern));
  }
  ilike<C extends FilterColumn<TableRow<S, Name>>>(column: C, pattern: string): this {
    return this.#filter(column, 'ilike', scalar(pattern));
  }
  in<C extends FilterColumn<TableRow<S, Name>>>(column: C, values: readonly ValueFor<TableRow<S, Name>, C>[]): this {
    return this.#filter(column, 'in', inList(values));
  }
  is<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: IsValue): this {
    return this.#filter(column, 'is', isOperand(value));
  }
  /** Every pair must match (`eq` for each). */
  match(values: Partial<{ [C in string & keyof TableRow<S, Name>]: FilterValue<TableRow<S, Name>[C]> }>): this {
    let next = this;
    for (const [column, value] of Object.entries(values)) {
      if (value !== undefined) next = next.#filter(column, 'eq', scalar(value));
    }
    return next;
  }
  /** Negates one filter: `.not('status', 'eq', 'cancelled')`, `.not('x', 'is', null)`. */
  not<C extends FilterColumn<TableRow<S, Name>>>(column: C, op: CompareOperator | 'in' | 'is', value: unknown): this {
    if (op === 'in') return this.#filter(column, 'not.in', inList(value as readonly unknown[]));
    if (op === 'is') return this.#filter(column, 'not.is', isOperand(value as IsValue));
    return this.#filter(column, `not.${compareOperator(op)}`, scalar(value));
  }
  /** Any of the conditions: `.or((c) => [c.eq('a', 1), c.gt('b', 2)])`. */
  or<Options extends ReferencedOption | undefined = undefined>(build: (c: Conditions<GroupRow<S, Name, Options>>) => readonly Condition[], options?: Options): this {
    return this.#param(referenced('or', options), encodeGroup(build(new Conditions<GroupRow<S, Name, Options>>())));
  }
  /** All of the conditions, as a group (combine with `not` inside `or`). */
  and<Options extends ReferencedOption | undefined = undefined>(build: (c: Conditions<GroupRow<S, Name, Options>>) => readonly Condition[], options?: Options): this {
    return this.#param(referenced('and', options), encodeGroup(build(new Conditions<GroupRow<S, Name, Options>>())));
  }

  // ----------------------------------------------------------- modifiers

  /** Appends an ordering term; calls accumulate in order. */
  order(column: string & keyof TableRow<S, Name>, options?: OrderOptions): this;
  order(column: string, options?: OrderOptions): this;
  order(column: string, options: OrderOptions = {}): this {
    const key = referenced('order', options);
    let term = identifier(column, 'column');
    term += options.ascending === false ? '.desc' : '.asc';
    if (options.nullsFirst !== undefined) term += options.nullsFirst ? '.nullsfirst' : '.nullslast';
    const params = [...this.#state.params];
    const index = params.findIndex(([k]) => k === key);
    if (index >= 0) {
      params[index] = [key, `${params[index]![1]},${term}`];
      return this.#with({ params });
    }
    params.push([key, term]);
    return this.#with({ params });
  }

  limit(count: number, options?: ReferencedOption): this {
    return this.#replace(referenced('limit', options), nonNegative('limit', count));
  }

  /** Skips the first `count` rows (combine with `limit`, or use `range`). */
  offset(count: number, options?: ReferencedOption): this {
    return this.#replace(referenced('offset', options), nonNegative('offset', count));
  }

  /** Rows `from` to `to`, both included (zero-based). */
  range(from: number, to: number, options?: ReferencedOption): this {
    nonNegative('range start', from);
    if (to < from) throw new NelcotaUsageError('range end must be >= start');
    return this.#replace(referenced('offset', options), String(from)).#replace(
      referenced('limit', options),
      nonNegative('range end', to - from + 1),
    );
  }

  #replace(key: string, value: string): this {
    const params = this.#state.params.filter(([k]) => k !== key);
    return this.#with({ params: [...params, [key, value]] });
  }

  /** Exactly one row, or an error (`not_single`). */
  single(this: [Out] extends [null] ? never : Query<S, Name, Row, Out, Head, Throws>): Query<S, Name, Row, Row, Head, Throws> {
    this.#requireRows();
    return this.#with({ cardinality: 'one' }) as unknown as Query<S, Name, Row, Row, Head, Throws>;
  }

  /** One row or `null`; more than one is an error (`not_single`). */
  maybeSingle(this: [Out] extends [null] ? never : Query<S, Name, Row, Out, Head, Throws>): Query<S, Name, Row, Row | null, Head, Throws> {
    this.#requireRows();
    return this.#with({ cardinality: 'maybe' }) as unknown as Query<S, Name, Row, Row | null, Head, Throws>;
  }

  #requireRows(): void {
    if (!this.#state.returnsRows || this.#state.method === 'HEAD') {
      throw new NelcotaUsageError('single/maybeSingle requires rows: call select() on writes and omit head: true');
    }
  }

  /**
   * After `insert`/`update`/`upsert`/`delete`: return the affected rows,
   * with these columns and embeds.
   */
  select<Q extends string = '*'>(columns?: Q): Query<S, Name, SelectRow<S, Name, Q>, Head extends true ? null : Reselected<Out, SelectRow<S, Name, Q>>, Head, Throws> {
    const params = this.#state.params.filter(([k]) => k !== 'select');
    const next = this.#with({
      params: [...params, ['select', selectList(columns ?? '*')]],
      prefer: [...this.#state.prefer.filter((p) => !p.startsWith('return=')), 'return=representation'],
      returnsRows: this.#state.method !== 'HEAD',
    });
    return next as unknown as Query<S, Name, SelectRow<S, Name, Q>, Head extends true ? null : Reselected<Out, SelectRow<S, Name, Q>>, Head, Throws>;
  }

  abortSignal(signal: AbortSignal): this {
    return this.#with({ signal });
  }

  /** Timeout for this request in ms (`0` disables it). */
  timeout(ms: number): this {
    return this.#with({ timeout: ms });
  }

  /** The query string this builder sends, for logs and tests. */
  toString(): string {
    return this.#params().toString();
  }

  // ------------------------------------------------------------ sending

  /**
   * Awaiting the query throws its `NelcotaError` instead of returning it,
   * and the result type drops the error branch:
   * `const { data } = await nelcota.from('notes').select().throwOnError()`.
   */
  throwOnError(): Query<S, Name, Row, Out, Head, true> {
    return this.#with({ throws: true }) as unknown as Query<S, Name, Row, Out, Head, true>;
  }

  /** Sends the request; throws on failure after `throwOnError()`. */
  async execute(): Promise<QueryOutcome<Out, Throws>> {
    const result = await this.#run();
    if (result.error && this.#state.throws) throw result.error;
    return result as QueryOutcome<Out, Throws>;
  }

  #params(): URLSearchParams {
    const state = this.#state;
    const params = new URLSearchParams(state.params.map(([k, v]) => [k, v]));
    if (state.cardinality !== 'many' && state.method === 'GET' && !params.has('limit')) params.set('limit', '2');
    return params;
  }
  async #run(): Promise<QueryResult<Out>> {
    const state = this.#state;
    const headers: Record<string, string> = {};
    if (state.prefer.length > 0) headers['prefer'] = state.prefer.join(',');
    const { data: rows, response, error } = await state.http.json<unknown>({
      method: state.method,
      path: `/rest/v1/${encodeURIComponent(state.table)}`,
      query: this.#params(),
      json: state.body,
      headers,
      signal: state.signal,
      timeout: state.timeout,
    });
    if (error) return { data: null, error, count: null, range: null, status: error.status };

    const contentRange = response.headers.get('content-range');
    const count = countFromRange(contentRange);
    const range = rangeFromHeader(contentRange);
    if (state.returnsRows && (!Array.isArray(rows) || !rows.every(isRecord))) {
      const error = new NelcotaError({ status: response.status, code: 'invalid_response', message: 'The server answered with something that is not an array of rows' });
      return { data: null, error, count: null, range: null, status: response.status };
    }
    if (state.cardinality === 'many') {
      return { data: rows as Out, error: null, count, range, status: response.status };
    }
    if (!Array.isArray(rows)) throw new NelcotaUsageError('single/maybeSingle requires a row representation');
    if (rows.length === 1 || (rows.length === 0 && state.cardinality === 'maybe')) {
      return { data: (rows[0] ?? null) as Out, error: null, count, range, status: response.status };
    }
    const failure = new NelcotaError({
      status: 406,
      code: 'not_single',
      message: `Expected ${state.cardinality === 'one' ? 'exactly one row' : 'at most one row'}, got ${rows.length === 2 && state.method === 'GET' ? 'more than one' : rows.length}`,
    });
    return { data: null, error: failure, count: null, range: null, status: failure.status };
  }

  /**
   * Reads every matching row, `size` rows per request, from the current
   * offset on. Order by a unique column so pages do not overlap. It ends at
   * the first empty page, so a server row cap smaller than `size` cannot cut
   * it short; a failed page throws its `NelcotaError`.
   *
   * ```ts
   * for await (const page of nelcota.from('notes').select().order('id').pages(500)) { ... }
   * ```
   */
  async *pages<T extends boolean>(this: Query<S, Name, Row, Row[], false, T>, size: number): AsyncGenerator<Row[], void, undefined> {
    const state = this.#state;
    if (state.method !== 'GET' || state.cardinality !== 'many') {
      throw new NelcotaUsageError('pages() works on select() reads, without single/maybeSingle or head: true');
    }
    if (!Number.isSafeInteger(size) || size < 1) throw new NelcotaUsageError('page size must be an integer >= 1');
    const start = state.params.find(([k]) => k === 'offset')?.[1];
    let offset = start === undefined ? 0 : Number(start);
    for (;;) {
      const { data, error } = await this.offset(offset).limit(size).#run();
      if (error) throw error;
      if (data.length === 0) return;
      yield data;
      offset += data.length;
    }
  }

  then<A = QueryOutcome<Out, Throws>, B = never>(
    onfulfilled?: ((value: QueryOutcome<Out, Throws>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function nonNegative(what: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NelcotaUsageError(`${what} must be an integer >= 0`);
  }
  return String(value);
}

/**
 * A select list is written by the developer, not by users, but it still
 * cannot carry characters outside the grammar (quotes, control characters).
 */
export function selectList(columns: string): string {
  if (typeof columns !== 'string' || columns.trim() === '' || /["\\\p{Cc}]/u.test(columns.replace(/\s+/g, ' '))) {
    throw new NelcotaUsageError(`Invalid select ${JSON.stringify(columns)}`);
  }
  return columns.replace(/\s+/g, '');
}

// ------------------------------------------------------------------ entry

/** `client.from(table)`: picks the operation. */
export class TableRef<S extends GenericSchema, Name extends string, Row, Insert, Update> {
  readonly #http: HttpClient;
  readonly #table: string;

  /** @internal */
  constructor(http: HttpClient, table: string) {
    this.#http = http;
    this.#table = identifier(table, 'table');
  }

  #query<R, O, Head extends boolean = false>(method: Method, extra: Partial<State> = {}): Query<S, Name, R, O, Head> {
    return new Query<S, Name, R, O>({
      http: this.#http,
      table: this.#table,
      method,
      params: [],
      prefer: [],
      cardinality: 'many',
      returnsRows: false,
      ...extra,
    });
  }

  /** Reads rows: columns, `*` and embeds (`id,author:users(email)`). */
  select<Q extends string = '*', Head extends boolean = false>(
    columns?: Q,
    options: SelectOptions<Head> = {},
  ): Query<S, Name, SelectRow<S, Name, Q>, Head extends true ? null : SelectRow<S, Name, Q>[], Head> {
    return this.#query(options.head ? 'HEAD' : 'GET', {
      params: [['select', selectList(columns ?? '*')]],
      prefer: options.count === 'exact' ? ['count=exact'] : [],
      returnsRows: !options.head,
    });
  }

  /** Inserts one row or many (one statement). Add `.select()` to get them back. */
  insert(values: Insert | readonly Insert[]): Query<S, Name, Row, null> {
    return this.#query('POST', { body: rowsBody(values), prefer: ['return=minimal'] });
  }

  /** Inserts, or merges into (or keeps) rows that hit a unique key. */
  upsert(values: Insert | readonly Insert[], options: UpsertOptions = {}): Query<S, Name, Row, null> {
    const params: [string, string][] = [];
    if (options.onConflict !== undefined) {
      const columns = typeof options.onConflict === 'string' ? options.onConflict.split(',') : options.onConflict;
      params.push(['on_conflict', columns.map((c) => identifier(c.trim(), 'column')).join(',')]);
    }
    const resolution = options.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates';
    return this.#query('POST', { body: rowsBody(values), params, prefer: ['return=minimal', resolution] });
  }

  /** Changes the rows that match the filters (at least one is required). */
  update(values: Update): Query<S, Name, Row, null> {
    if (!isRecord(values)) {
      throw new NelcotaUsageError('update takes one object with the new values');
    }
    return this.#query('PATCH', { body: values, prefer: ['return=minimal'] });
  }

  /** Deletes the rows that match the filters (at least one is required). */
  delete(): Query<S, Name, Row, null> {
    return this.#query('DELETE', { prefer: ['return=minimal'] });
  }
}

function rowsBody(values: unknown): unknown {
  if (isRecord(values)) return values;
  if (!Array.isArray(values)) {
    throw new NelcotaUsageError('insert takes an object or an array of objects');
  }
  if (values.length === 0) {
    throw new NelcotaUsageError('insert needs at least one row');
  }
  for (const row of values) {
    if (!isRecord(row)) throw new NelcotaUsageError('insert takes an object or an array of objects');
  }
  return values;
}
