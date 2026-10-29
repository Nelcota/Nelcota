// Table grid filters.
//
// In the panel URL they use the REST API format (`?price=gte.10&name=ilike.*a*`),
// so a link can be shared and the browser's back button works. To the panel
// API they go as typed JSON (`filters=[...]`), validated by the server.

import { t, type MessageKey, type Params } from "$lib/i18n/index.svelte";
const NEGATION_PREFIX_LENGTH = 4;

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "ilike" | "is";

export interface TableFilter {
  column: string;
  op: FilterOp;
  value: string;
  not?: boolean;
}

const OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "is"];
const isOp = (op: string): op is FilterOp => (OPS as readonly string[]).includes(op);

/** Operators as the form shows them (some become two fields on the wire). */
export type UiOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "null" | "notnull";

/** `label` is a translation key: render it with `t(op.label)`. */
export const UI_OPERATORS: readonly { value: UiOp; label: MessageKey; needsValue: boolean }[] = [
  { value: "eq", label: "tables.filters.ops.eq", needsValue: true },
  { value: "neq", label: "tables.filters.ops.neq", needsValue: true },
  { value: "contains", label: "tables.filters.ops.contains", needsValue: true },
  { value: "gt", label: "tables.filters.ops.gt", needsValue: true },
  { value: "gte", label: "tables.filters.ops.gte", needsValue: true },
  { value: "lt", label: "tables.filters.ops.lt", needsValue: true },
  { value: "lte", label: "tables.filters.ops.lte", needsValue: true },
  { value: "null", label: "tables.filters.ops.null", needsValue: false },
  { value: "notnull", label: "tables.filters.ops.notnull", needsValue: false },
];

export const needsValue = (op: UiOp) =>
  UI_OPERATORS.find((o) => o.value === op)?.needsValue ?? true;

/** `not` negates the operator (a `not.` filter opened in the form keeps it). */
export function fromUi({
  column,
  op,
  value,
  not = false,
}: {
  column: string;
  op: UiOp;
  value: string;
  not?: boolean | undefined;
}): TableFilter {
  if (op === "contains") return { column, op: "ilike", value: `*${value}*`, ...(not && { not }) };
  if (op === "null" || op === "notnull")
    return { column, op: "is", value: "null", ...(op === "notnull" && { not: true }) };
  return { column, op, value, ...(not && { not }) };
}

export function toUi(filter: TableFilter): { op: UiOp; value: string } {
  if (filter.op === "is" && filter.value === "null")
    return { op: filter.not === true ? "notnull" : "null", value: "" };
  const contains = filter.op === "ilike" && /^\*.*\*$/.test(filter.value);
  if (contains && filter.not !== true) return { op: "contains", value: filter.value.slice(1, -1) };
  return { op: filter.op as UiOp, value: filter.value };
}

/** Short text for the filter chip: `price greater than 10`, `name contains a`. */
export function describe(
  filter: TableFilter,
  translate: (key: MessageKey, params?: Params) => string = t,
): string {
  const { op, value } = toUi(filter);
  const key = UI_OPERATORS.find((o) => o.value === op)?.label;
  const label = key != null ? translate(key) : filter.op;
  const prefix =
    filter.not === true && op !== "notnull" ? `${translate("tables.filters.not")} ` : "";
  return needsValue(op)
    ? `${filter.column} ${prefix}${label} ${value}`
    : `${filter.column} ${label}`;
}

/** Reads the filters from the URL query string; invalid pairs are ignored. */
export function parseFilters(query: URLSearchParams): TableFilter[] {
  const filters: TableFilter[] = [];
  for (const [column, raw] of query) {
    const not = raw.startsWith("not.");
    const rest = not ? raw.slice(NEGATION_PREFIX_LENGTH) : raw;
    const dot = rest.indexOf(".");
    if (dot < 0) continue;
    const op = rest.slice(0, dot);
    if (isOp(op) === false) continue;
    filters.push({ column, op, value: rest.slice(dot + 1), ...(not && { not }) });
  }
  return filters;
}

/** Inverse of `parseFilters`: `price=gte.10&name=not.is.null`. */
export function filtersToSearch(filters: readonly TableFilter[]): string {
  const query = new URLSearchParams();
  for (const f of filters)
    query.append(f.column, `${f.not === true ? "not." : ""}${f.op}.${f.value}`);
  return query.toString();
}

/** Panel API format: JSON, or `undefined` without filters. */
export function filtersParam(filters: readonly TableFilter[]): string | undefined {
  return filters.length > 0 ? JSON.stringify(filters) : undefined;
}
