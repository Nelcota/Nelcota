/** Query result shapes and caller options, independent of the query implementation. */
import type { NelcotaError } from "../core/client.errors.js";
import type { FilterScalar } from "../core/encoding.js";
import type { FilterValue } from "./conditions.js";
import type { GenericSchema, RowOf, Relation } from "./types.js";

/**
 * The rows a read returned, zero-based and inclusive, from `Content-Range`.
 * `null` when no rows came back or the response has no range (writes).
 */
export interface RowRange {
  from: number;
  to: number;
}

export interface QuerySuccess<T> {
  data: T;
  error: null;
  /** Matching read rows or affected write rows with `count: 'exact'`, else `null`. */
  count: number | null;
  /** Which rows of the match these are. With `count`, `range.to + 1 < count` means more rows exist. */
  range: RowRange | null;
  status: number;
}

export type QueryResult<T> =
  | QuerySuccess<T>
  | { data: null; error: NelcotaError; count: null; range: null; status: number };

/** What awaiting a query gives: a result, or only a success after `throwOnError()`. */
export type QueryOutcome<T, Throws extends boolean> = Throws extends true
  ? QuerySuccess<T>
  : QueryResult<T>;

/** A column of the row, or a path into an embed (`orders.total`). */
export type FilterColumn<Row> = (string & keyof Row) | `${string}.${string}`;

export interface ReferencedOption {
  /** Applies to an embed (its alias), e.g. `orders` or `orders.items`. */
  referencedTable?: string;
}

export interface OrderOptions extends ReferencedOption {
  ascending?: boolean;
  nullsFirst?: boolean;
}

export interface CountOption {
  /** `exact` counts matching read rows (a second scan) or affected write rows. */
  count?: "exact";
}

export interface SelectOptions<Head extends boolean = boolean> extends CountOption {
  /** Only the count, no rows (a HEAD request). */
  head?: Head;
}

export interface UpsertOptions extends CountOption {
  /** Columns of the unique key to match (default: the primary key). */
  onConflict?: string | readonly string[];
  /** Keep existing rows instead of merging into them. */
  ignoreDuplicates?: boolean;
}

/** Filters and ordering use every column of the table, not only the selected ones. */
export type TableRow<S extends GenericSchema, Name extends string> = RowOf<Relation<S, Name>>;

export type ValueFor<Row, C> = C extends keyof Row ? FilterValue<Row[C]> : FilterScalar;

export type GroupRow<
  S extends GenericSchema,
  Name extends string,
  Options,
> = Options extends undefined
  ? TableRow<S, Name>
  : "referencedTable" extends keyof Options
    ? Record<string, unknown>
    : TableRow<S, Name>;

export type Reselected<Out, Row> = [Out] extends [null | readonly unknown[]]
  ? Row[]
  : null extends Out
    ? Row | null
    : Row;
