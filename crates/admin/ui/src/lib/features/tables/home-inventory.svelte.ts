import type { Overview, SchemaResponse } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { ddl } from "$lib/shared/schema/ddl";
import { api } from "$lib/transport/api";
export type { OverviewTable, TableSummary } from "$lib/contracts/types";

/** Keeps optional overview and schema requests independent from the main table list. */
export class HomeInventory {
  readonly overview = new RemoteResource<Overview>();
  readonly schema = new RemoteResource<SchemaResponse>();
  reload(): Promise<boolean> {
    return this.overview.load((signal) => api.get<Overview>("/overview", { signal }));
  }
  loadSchema(): Promise<boolean> {
    return this.schema.load((signal) => api.get<SchemaResponse>("/schema", { signal }));
  }
  enableRls(table: string) {
    return ddl.alterTable(table, [{ action: "set_rls", enabled: true }]);
  }
  cancel(): void {
    this.overview.cancel();
    this.schema.cancel();
  }
}
/** Encodes a table name as one panel route segment. */
export function tablePath(name: string): string {
  return `/tables/${encodeURIComponent(name)}`;
}
