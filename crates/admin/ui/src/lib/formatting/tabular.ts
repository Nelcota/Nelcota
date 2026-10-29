// Export of results already in the browser (SQL editor). Whole tables are
// exported by the server, streamed (`/tables/:name/export`).

type Cell = string | null;

function csvField(value: Cell): string {
  if (value === null) return "";
  // Protect spreadsheet imports, including headers and whitespace-prefixed
  // formulas. A negative numeric literal is safe; keep all its original digits.
  const negativeNumber = /^-(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
  const significant = value.replace(/^[\s\p{Cc}]*/u, "");
  if (
    negativeNumber === false &&
    (/^[\t\r\n]/.test(value) || /^[=+\-@＝＋－＠]/.test(significant))
  ) {
    return `"\t${value.replaceAll('"', '""')}"`;
  }
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Spreadsheet-safe CSV with a BOM. Dangerous text gets a quoted tab prefix;
 * JSON export keeps the original values. NULL = empty field. */
export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [columns, ...rows].map((row) => row.map(csvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Keys for JSON objects: a repeated column name (`a.id, b.id`) gets a numeric
 * suffix (`id_2`) that no other column uses, so no value is overwritten. */
export function uniqueKeys(columns: readonly string[]): string[] {
  const used = new Set(columns);
  const seen = new Set<string>();
  return columns.map((column) => {
    if (seen.has(column) === false) {
      seen.add(column);
      return column;
    }
    let suffix = 2;
    while (used.has(`${column}_${suffix}`)) suffix += 1;
    const key = `${column}_${suffix}`;
    used.add(key);
    return key;
  });
}

/** Array of objects; values stay as Postgres returned them (text). */
export function toJson(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const keys = uniqueKeys(columns);
  const objects = rows.map((row) =>
    Object.fromEntries(keys.map((key, i) => [key, row[i] ?? null])),
  );
  return `${JSON.stringify(objects, null, 2)}\n`;
}
