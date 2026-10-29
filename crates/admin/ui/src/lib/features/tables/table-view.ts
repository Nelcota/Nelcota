import { parsePage } from "$lib/navigation/pagination";

export interface TableView {
  page: number;
  size: string;
  sort: { column: string; desc: boolean } | null;
}

const SIZES = new Set(["25", "50", "100", "500"]);

/** UI parameters are distinct from REST-style column filters. */
export function parseTableView(query: URLSearchParams): TableView {
  const size = query.get("_size") ?? "50";
  const column = query.get("_sort");
  return {
    page: parsePage(query.get("_page")),
    size: SIZES.has(size) ? size : "50",
    sort: column != null && column !== "" ? { column, desc: query.get("_desc") === "true" } : null,
  };
}

export function tableViewSearch(query: URLSearchParams, patch: Partial<TableView>): string {
  const params = new URLSearchParams(query);
  if (patch.page !== undefined) {
    params.delete("_page");
    if (Number.isSafeInteger(patch.page) && patch.page > 0) params.set("_page", String(patch.page));
  }
  if (patch.size !== undefined) {
    params.delete("_size");
    if (patch.size !== "50" && SIZES.has(patch.size)) params.set("_size", patch.size);
  }
  applySort(params, patch.sort);
  return params.toString();
}

function applySort(params: URLSearchParams, sort: TableView["sort"] | undefined): void {
  if (sort === undefined) return;
  params.delete("_sort");
  params.delete("_desc");
  if (sort === null) return;
  params.set("_sort", sort.column);
  if (sort.desc) params.set("_desc", "true");
}
