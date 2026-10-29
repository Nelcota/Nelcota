import { NelcotaUsageError } from "../core/client.errors.js";
import { columnPath, quote } from "../core/encoding.js";
import { requiredValue } from "../core/required-value.js";
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
