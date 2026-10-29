import type { TablesResponse } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api, ApiError } from "$lib/transport/api";

/** Owns publication of the table catalog independently from a selected table's rows. */
export class TableCatalog extends RemoteResource<TablesResponse> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<TablesResponse>("/tables", { signal }));
  }
}
/** View denial describes the selected caller rather than a failed table load. */
export function deniedViewer(error: unknown): "anon" | "authenticated" | null {
  if (error instanceof ApiError === false || error.code !== "view_denied") return null;
  return error.params?.role === "anon" ? "anon" : "authenticated";
}
