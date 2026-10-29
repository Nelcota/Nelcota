import type { TableData } from "$lib/contracts/types";
import { api, enc } from "$lib/transport/api";

import type { TableRowsAdapter } from "./rows/table-rows.svelte";

/** The panel HTTP adapter for row operations. */
export const tableRowsApi: TableRowsAdapter = {
  read: (table, params, signal) =>
    api.get<TableData>(`/tables/${enc(table)}?${params}`, { signal }),
  update: (table, pk, values) =>
    api.patch<{ count: number }>(`/tables/${enc(table)}/rows`, { pk, values }),
  remove: (table, pks) => api.delete<{ count: number }>(`/tables/${enc(table)}/rows`, { pks }),
};
