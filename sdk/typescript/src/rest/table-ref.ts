import { NelcotaUsageError } from "../core/client.errors.js";
import { identifier } from "../core/encoding.js";
import type { HttpClient } from "../core/http/client.js";
import { isRecord } from "../core/json.js";
import type { Method, State } from "./query-state.js";
import type { CountOption, SelectOptions, UpsertOptions } from "./query-types.js";
import { Query, selectList } from "./query.js";
import type { GenericSchema, SelectRow } from "./types.js";

// ------------------------------------------------------------------ entry

/** `client.from(table)`: picks the operation. */
export class TableRef<S extends GenericSchema, Name extends string, Row, Insert, Update> {
  readonly #http: HttpClient;
  readonly #table: string;

  /** @internal */
  constructor(http: HttpClient, table: string) {
    this.#http = http;
    this.#table = identifier(table, "table");
  }

  #query<R, O, Head extends boolean = false>(
    method: Method,
    extra: Partial<State> = {},
  ): Query<S, Name, R, O, Head> {
    return new Query<S, Name, R, O>({
      http: this.#http,
      table: this.#table,
      method,
      params: [],
      prefer: [],
      cardinality: "many",
      returnsRows: false,
      ...extra,
    });
  }

  /** Reads rows: columns, `*` and embeds (`id,author:users(email)`). */
  select<Q extends string = "*", Head extends boolean = false>(
    columns?: Q,
    options: SelectOptions<Head> = {},
  ): Query<
    S,
    Name,
    SelectRow<S, Name, Q>,
    Head extends true ? null : SelectRow<S, Name, Q>[],
    Head
  > {
    return this.#query(options.head === true ? "HEAD" : "GET", {
      params: [["select", selectList(columns ?? "*")]],
      prefer: options.count === "exact" ? ["count=exact"] : [],
      returnsRows: Boolean(options.head) === false,
    });
  }

  /** Inserts one row or many (one statement). Add `.select()` to get them back. */
  insert(values: Insert | readonly Insert[], options: CountOption = {}): Query<S, Name, Row, null> {
    return this.#query("POST", { body: rowsBody(values), prefer: writePreferences(options) });
  }

  /** Inserts, or merges into (or keeps) rows that hit a unique key. */
  upsert(
    values: Insert | readonly Insert[],
    options: UpsertOptions = {},
  ): Query<S, Name, Row, null> {
    const params: [string, string][] = [];
    if (options.onConflict !== undefined) {
      const columns =
        typeof options.onConflict === "string" ? options.onConflict.split(",") : options.onConflict;
      params.push(["on_conflict", columns.map((c) => identifier(c.trim(), "column")).join(",")]);
    }
    const resolution =
      options.ignoreDuplicates === true
        ? "resolution=ignore-duplicates"
        : "resolution=merge-duplicates";
    return this.#query("POST", {
      body: rowsBody(values),
      params,
      prefer: [...writePreferences(options), resolution],
    });
  }

  /** Changes the rows that match the filters (at least one is required). */
  update(values: Update, options: CountOption = {}): Query<S, Name, Row, null> {
    if (isRecord(values) === false) {
      throw new NelcotaUsageError("update takes one object with the new values");
    }
    return this.#query("PATCH", { body: values, prefer: writePreferences(options) });
  }

  /** Deletes the rows that match the filters (at least one is required). */
  delete(options: CountOption = {}): Query<S, Name, Row, null> {
    return this.#query("DELETE", { prefer: writePreferences(options) });
  }
}

function writePreferences(options: CountOption): string[] {
  return options.count === "exact" ? ["return=minimal", "count=exact"] : ["return=minimal"];
}

function rowsBody(values: unknown): unknown {
  if (isRecord(values)) return values;
  if (Array.isArray(values) === false) {
    throw new NelcotaUsageError("insert takes an object or an array of objects");
  }
  if (values.length === 0) {
    throw new NelcotaUsageError("insert needs at least one row");
  }
  for (const row of values) {
    if (isRecord(row) === false)
      throw new NelcotaUsageError("insert takes an object or an array of objects");
  }
  return values;
}
