import { requiredValue } from "../core/required-value.js";
import { filterParam, referenced, nonNegative, selectList } from "./query-encoding.js";
import { executeQuery, queryParams } from "./query-execution.js";
import type { TableRow, ValueFor, GroupRow, Reselected } from "./query-types.js";
export { selectList } from "./query-encoding.js";
export { countFromRange, rangeFromHeader } from "./query-execution.js";
import { NelcotaUsageError } from "../core/client.errors.js";
/**
 * The query builder. Each call returns a new builder (a base query can be
 * reused safely), and execute() sends exactly one request.
 */
import { identifier, inList, scalar } from "../core/encoding.js";
import {
  Conditions,
  compareOperator,
  encodeGroup,
  isOperand,
  type CompareOperator,
  type Condition,
  type FilterValue,
  type IsValue,
} from "./conditions.js";
import type { State } from "./query-state.js";
import type {
  FilterColumn,
  OrderOptions,
  QueryOutcome,
  QueryResult,
  ReferencedOption,
} from "./query-types.js";
import type { GenericSchema, SelectRow } from "./types.js";
export type {
  CountOption,
  FilterColumn,
  OrderOptions,
  QueryOutcome,
  QueryResult,
  QuerySuccess,
  ReferencedOption,
  RowRange,
  SelectOptions,
  UpsertOptions,
} from "./query-types.js";

export class Query<
  S extends GenericSchema,
  Name extends string,
  Row,
  Out,
  Head extends boolean = false,
  Throws extends boolean = false,
> {
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
    const [key, operand] = filterParam(column, op, value);
    return this.#param(key, operand);
  }

  // ------------------------------------------------------------- filters

  eq<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "eq", scalar(value));
  }
  neq<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "neq", scalar(value));
  }
  gt<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "gt", scalar(value));
  }
  gte<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "gte", scalar(value));
  }
  lt<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "lt", scalar(value));
  }
  lte<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    value: ValueFor<TableRow<S, Name>, C>,
  ): this {
    return this.#filter(column, "lte", scalar(value));
  }
  /** `*` (or `%`) matches any text. Wrap typed input in `escapeLike`. */
  like<C extends FilterColumn<TableRow<S, Name>>>(column: C, pattern: string): this {
    return this.#filter(column, "like", scalar(pattern));
  }
  ilike<C extends FilterColumn<TableRow<S, Name>>>(column: C, pattern: string): this {
    return this.#filter(column, "ilike", scalar(pattern));
  }
  in<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    values: readonly ValueFor<TableRow<S, Name>, C>[],
  ): this {
    return this.#filter(column, "in", inList(values));
  }
  is<C extends FilterColumn<TableRow<S, Name>>>(column: C, value: IsValue): this {
    return this.#filter(column, "is", isOperand(value));
  }
  /** Every pair must match (`eq` for each). */
  match(
    values: Partial<{ [C in string & keyof TableRow<S, Name>]: FilterValue<TableRow<S, Name>[C]> }>,
  ): this {
    const filters = Object.entries(values).flatMap(([column, value]) =>
      value === undefined ? [] : [filterParam(column, "eq", scalar(value))],
    );
    return filters.length === 0
      ? this
      : this.#with({ params: [...this.#state.params, ...filters] });
  }
  /** Negates one filter: `.not('status', 'eq', 'cancelled')`, `.not('x', 'is', null)`. */
  not<C extends FilterColumn<TableRow<S, Name>>>(
    column: C,
    op: CompareOperator | "in" | "is",
    value: unknown,
  ): this {
    if (op === "in") return this.#filter(column, "not.in", inList(value as readonly unknown[]));
    if (op === "is") return this.#filter(column, "not.is", isOperand(value as IsValue));
    return this.#filter(column, `not.${compareOperator(op)}`, scalar(value));
  }
  /** Any of the conditions: `.or((c) => [c.eq('a', 1), c.gt('b', 2)])`. */
  or<Options extends ReferencedOption | undefined = undefined>(
    build: (c: Conditions<GroupRow<S, Name, Options>>) => readonly Condition[],
    options?: Options,
  ): this {
    return this.#param(
      referenced("or", options),
      encodeGroup(build(new Conditions<GroupRow<S, Name, Options>>())),
    );
  }
  /** All of the conditions, as a group (combine with `not` inside `or`). */
  and<Options extends ReferencedOption | undefined = undefined>(
    build: (c: Conditions<GroupRow<S, Name, Options>>) => readonly Condition[],
    options?: Options,
  ): this {
    return this.#param(
      referenced("and", options),
      encodeGroup(build(new Conditions<GroupRow<S, Name, Options>>())),
    );
  }

  // ----------------------------------------------------------- modifiers

  /** Appends an ordering term; calls accumulate in order. */
  order(column: string & keyof TableRow<S, Name>, options?: OrderOptions): this;
  order(column: string, options?: OrderOptions): this;
  order(column: string, options: OrderOptions = {}): this {
    const key = referenced("order", options);
    let term = identifier(column, "column");
    term += options.ascending === false ? ".desc" : ".asc";
    if (options.nullsFirst !== undefined) term += options.nullsFirst ? ".nullsfirst" : ".nullslast";
    const params = [...this.#state.params];
    const index = params.findIndex(([k]) => k === key);
    if (index >= 0) {
      params[index] = [
        key,
        `${requiredValue(params[index], "required operation value")[1]},${term}`,
      ];
      return this.#with({ params });
    }
    params.push([key, term]);
    return this.#with({ params });
  }

  limit(count: number, options?: ReferencedOption): this {
    return this.#replace(referenced("limit", options), nonNegative("limit", count));
  }

  /** Skips the first `count` rows (combine with `limit`, or use `range`). */
  offset(count: number, options?: ReferencedOption): this {
    return this.#replace(referenced("offset", options), nonNegative("offset", count));
  }

  /** Rows `from` to `to`, both included (zero-based). */
  range(from: number, to: number, options?: ReferencedOption): this {
    nonNegative("range start", from);
    if (to < from) throw new NelcotaUsageError("range end must be >= start");
    return this.#replace(referenced("offset", options), String(from)).#replace(
      referenced("limit", options),
      nonNegative("range end", to - from + 1),
    );
  }

  #replace(key: string, value: string): this {
    const params = this.#state.params.filter(([k]) => k !== key);
    return this.#with({ params: [...params, [key, value]] });
  }

  /** Exactly one row, or an error (`not_single`). */
  single(
    this: [Out] extends [null] ? never : Query<S, Name, Row, Out, Head, Throws>,
  ): Query<S, Name, Row, Row, Head, Throws> {
    this.#requireRows();
    return this.#with({ cardinality: "one" }) as unknown as Query<S, Name, Row, Row, Head, Throws>;
  }

  /** One row or `null`; more than one is an error (`not_single`). */
  maybeSingle(
    this: [Out] extends [null] ? never : Query<S, Name, Row, Out, Head, Throws>,
  ): Query<S, Name, Row, Row | null, Head, Throws> {
    this.#requireRows();
    return this.#with({ cardinality: "maybe" }) as unknown as Query<
      S,
      Name,
      Row,
      Row | null,
      Head,
      Throws
    >;
  }

  #requireRows(): void {
    if (this.#state.returnsRows === false || this.#state.method === "HEAD") {
      throw new NelcotaUsageError(
        "single/maybeSingle requires rows: call select() on writes and omit head: true",
      );
    }
  }

  /**
   * After `insert`/`update`/`upsert`/`delete`: return the affected rows,
   * with these columns and embeds.
   */
  select<Q extends string = "*">(
    columns?: Q,
  ): Query<
    S,
    Name,
    SelectRow<S, Name, Q>,
    Head extends true ? null : Reselected<Out, SelectRow<S, Name, Q>>,
    Head,
    Throws
  > {
    const params = this.#state.params.filter(([k]) => k !== "select");
    const next = this.#with({
      params: [...params, ["select", selectList(columns ?? "*")]],
      prefer: [
        ...this.#state.prefer.filter((p) => p.startsWith("return=") === false),
        "return=representation",
      ],
      returnsRows: this.#state.method !== "HEAD",
    });
    return next as unknown as Query<
      S,
      Name,
      SelectRow<S, Name, Q>,
      Head extends true ? null : Reselected<Out, SelectRow<S, Name, Q>>,
      Head,
      Throws
    >;
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
   * Executing the query throws its `NelcotaError` instead of returning it,
   * and the result type drops the error branch:
   * `const { data } = await nelcota.from('notes').select().throwOnError().execute()`.
   */
  throwOnError(): Query<S, Name, Row, Out, Head, true> {
    return this.#with({ throws: true }) as unknown as Query<S, Name, Row, Out, Head, true>;
  }

  /**
   * Sends one request for this query's current filters and options.
   *
   * @remarks
   * Builders are not promises. Call this method explicitly after constructing
   * a query; constructing or awaiting a builder does not send a request.
   *
   * @returns The query outcome, including returned rows and count metadata.
   * @throws When the request fails after `throwOnError()` has been enabled.
   */
  async execute(): Promise<QueryOutcome<Out, Throws>> {
    const result = await this.#run();
    if (result.error != null && this.#state.throws === true) throw result.error;
    return result as QueryOutcome<Out, Throws>;
  }

  #params(): URLSearchParams {
    return queryParams(this.#state);
  }
  async #run(): Promise<QueryResult<Out>> {
    return await executeQuery<Out>(this.#state);
  }

  /**
   * Reads every matching row, `size` rows per request, from the current
   * offset on. Order by a unique column so pages do not overlap. It ends at
   * the first empty page, so a server row cap smaller than `size` cannot cut
   * it short; a failed page throws its `NelcotaError`.
   *
   * @yields The next page of matching rows, in the query order.
   *
   * ```ts
   * for await (const page of nelcota.from('notes').select().order('id').pages(500)) { ... }
   * ```
   */
  async *pages<T extends boolean>(
    this: Query<S, Name, Row, Row[], false, T>,
    size: number,
  ): AsyncGenerator<Row[], void, undefined> {
    const state = this.#state;
    if (state.method !== "GET" || state.cardinality !== "many") {
      throw new NelcotaUsageError(
        "pages() works on select() reads, without single/maybeSingle or head: true",
      );
    }
    if (Number.isSafeInteger(size) === false || size < 1)
      throw new NelcotaUsageError("page size must be an integer >= 1");
    const start = state.params.find(([k]) => k === "offset")?.[1];
    let offset = start === undefined ? 0 : Number(start);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Advance pagination only after accepting the previous page and checking its terminal result.
      const { data, error } = await this.offset(offset).limit(size).#run();
      if (error != null) throw error;
      if (data.length === 0) return;
      yield data;
      offset += data.length;
    }
  }
}
