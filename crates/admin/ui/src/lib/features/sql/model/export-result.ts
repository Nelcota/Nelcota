import { downloadText } from "$lib/browser/download";
import type { SqlResult } from "$lib/contracts/types";
import { toCsv, toJson } from "$lib/formatting/tabular";

/** Export one result with its query name and result index, retaining the wire values. */
export function downloadSqlResult(
  result: SqlResult,
  options: { baseName: string; index: number; format: "csv" | "json" },
): void {
  const base = options.baseName.replaceAll(/[^\w-]+/g, "_");
  const suffix = options.index > 0 ? `-${options.index + 1}` : "";
  const name = `${base}${suffix}.${options.format}`;
  if (options.format === "csv") {
    downloadText(name, toCsv(result.columns, result.rows), "text/csv;charset=utf-8");
    return;
  }
  downloadText(name, toJson(result.columns, result.rows), "application/json");
}
