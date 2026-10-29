import type { SchemaResponse, SqlResponse } from "$lib/contracts/types";
import { api } from "$lib/transport/api";

import type { SqlAdapter } from "./execution.svelte";

export const sqlAdapter: SqlAdapter = {
  schema: (signal) => api.get<SchemaResponse>("/schema", { signal }),
  execute: (sql, signal, runAs) =>
    api.post<SqlResponse>("/sql", { sql, run_as: runAs ?? { role: "owner" } }, { signal }),
};
