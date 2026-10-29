import type { SnippetColumn } from "./api-examples";

const RESERVED = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
  "columns",
  "and",
  "or",
]);
const UNSUPPORTED_NAME = /[.,()":!*\\\s\p{Cc}]/u;
const MAX_NAME_BYTES = 63;
const encoder = new TextEncoder();
const logicOperand = (value: string): string =>
  `"${value.replaceAll(/[\\"]/g, (char) => `\\${char}`)}"`;

/** Builds complete primary-key filters; refuses keys the REST/SDK grammar cannot represent. */
export function exampleSelection(
  columns: readonly SnippetColumn[],
  primaryKey: readonly string[],
): {
  query: string;
  sdk: string;
} | null {
  if (primaryKey.length === 0) return null;
  const selected = primaryKey.map((name) => columns.find((column) => column.name === name));
  if (
    selected.some(
      (column) =>
        column === undefined ||
        column.name === "" ||
        UNSUPPORTED_NAME.test(column.name) ||
        encoder.encode(column.name).length > MAX_NAME_BYTES,
    )
  )
    return null;
  const keys = selected.filter((column) => column !== undefined);
  const values = keys.map((column) => column.enum_values?.[0] ?? keyValue(column.type));
  if (values.some((value) => value === null)) return null;
  const params = new URLSearchParams();
  const conditions: string[] = [];
  const sdk: string[] = [];
  for (const [index, column] of keys.entries()) {
    const value = values[index];
    if (value === undefined || value === null) return null;
    if (RESERVED.has(column.name))
      conditions.push(`${column.name}.eq.${logicOperand(String(value))}`);
    if (RESERVED.has(column.name) === false) params.append(column.name, `eq.${String(value)}`);
    sdk.push(`\n  .eq(${JSON.stringify(column.name)}, ${JSON.stringify(value)})`);
  }
  if (conditions.length > 0) params.append("and", `(${conditions.join(",")})`);
  return { query: params.toString(), sdk: sdk.join("") };
}
function keyValue(type: string): string | number | boolean | null {
  if (
    [
      "smallint",
      "integer",
      "bigint",
      "int2",
      "int4",
      "int8",
      "numeric",
      "real",
      "double precision",
    ].includes(type)
  )
    return 1;
  if (type === "uuid") return "00000000-0000-0000-0000-000000000000";
  if (type === "boolean" || type === "bool") return true;
  if (type === "date") return "2026-01-01";
  if (type.startsWith("timestamp")) return "2026-01-01T12:00:00Z";
  if (type === "text" || type.startsWith("character")) return "example";
  return null;
}
