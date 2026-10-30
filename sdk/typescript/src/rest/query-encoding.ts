import { NelcotaUsageError } from "../core/client.errors.js";
import { columnPath, quote } from "../core/encoding.js";
import { requiredValue } from "../core/required-value.js";
import type { Method, State } from "./query-state.js";
import type { ReferencedOption } from "./query-types.js";

const RESERVED = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "or",
  "and",
  "on_conflict",
  "columns",
]);

export function referenced(key: string, options: ReferencedOption | undefined): string {
  const table = options?.referencedTable;
  if (table === undefined) return key;
  return `${columnPath(table)}.${key}`;
}

export function filterParam(column: string, op: string, value: string): [string, string] {
  const parts = columnPath(column).split(".");
  const field = requiredValue(parts.pop(), "filter field");
  if (RESERVED.has(field)) {
    const operand = op.endsWith("in") || op.endsWith("is") ? value : quote(value);
    return [[...parts, "and"].join("."), `(${field}.${op}.${operand})`];
  }
  return [column, `${op}.${value}`];
}

/**
 * The server refuses filters on insert/upsert before running them, so refuse
 * them while building. Keys inside an embed (`orders.total`) filter the
 * returned representation and stay allowed.
 */
export function requireFilterable(method: Method, key: string): void {
  if (method === "POST" && key.includes(".") === false)
    throw new NelcotaUsageError("insert/upsert take no filters");
}

/** `order`, `limit` and `offset` apply to reads and to embeds of a write's `select()`. */
export function requirePageable(method: Method, name: string, key: string): void {
  if (key.includes(".") || method === "GET" || method === "HEAD") return;
  throw new NelcotaUsageError(
    method === "POST"
      ? `insert/upsert do not accept ${name}`
      : `update/delete change every matching row and do not accept ${name}`,
  );
}

/** `single`/`maybeSingle` need a row representation whose size is known before anything changes. */
export function requireRows(state: State): void {
  // The server has no singular write: it would change every matching row
  // and only then could the client count them.
  if (state.method === "PATCH" || state.method === "DELETE")
    throw new NelcotaUsageError(
      "single/maybeSingle cannot bound update/delete; check the returned rows",
    );
  if (state.returnsRows === false || state.method === "HEAD")
    throw new NelcotaUsageError(
      "single/maybeSingle requires rows: call select() on writes and omit head: true",
    );
}

/** Where `pages()` starts and how many rows an existing `limit` allows in total. */
export function pageCursor(params: State["params"]): { offset: number; remaining: number } {
  const start = params.find(([k]) => k === "offset")?.[1];
  const cap = params.find(([k]) => k === "limit")?.[1];
  return {
    offset: start === undefined ? 0 : Number(start),
    remaining: cap === undefined ? Number.POSITIVE_INFINITY : Number(cap),
  };
}

export function nonNegative(what: string, value: number): string {
  if (Number.isSafeInteger(value) === false || value < 0) {
    throw new NelcotaUsageError(`${what} must be an integer >= 0`);
  }
  return String(value);
}

/**
 * A select list is written by the developer, not by users, but it still
 * cannot carry characters outside the grammar (quotes, control characters).
 */
export function selectList(columns: string): string {
  if (
    typeof columns !== "string" ||
    columns.trim() === "" ||
    /["\\\p{Cc}]/u.test(columns.replaceAll(/\s+/g, " "))
  ) {
    throw new NelcotaUsageError(`Invalid select ${JSON.stringify(columns)}`);
  }
  return columns.replaceAll(/\s+/g, "");
}
