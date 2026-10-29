import type { StorageOverview } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api, enc } from "$lib/transport/api";
export type { Bucket } from "$lib/contracts/types";

/** Publishes the latest bucket inventory and performs explicit bucket deletion. */
export class StorageCatalog extends RemoteResource<StorageOverview> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<StorageOverview>("/storage", { signal }));
  }
  remove(id: string): Promise<unknown> {
    return api.delete(`/storage/buckets/${enc(id)}`);
  }
}
/** Encodes a bucket identifier as one panel route segment. */
export function bucketPath(id: string): string {
  return `/storage/${encodeURIComponent(id)}`;
}
