import type { DdlResult, StorageAccess } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api, enc } from "$lib/transport/api";

import type { TemplateId } from "./bucket-access.js";
export type { StoragePolicy } from "$lib/contracts/types";

/** Owns a bucket's policy requests while keeping publication cancellation independent. */
export class BucketPolicies extends RemoteResource<StorageAccess> {
  reload(bucket: string): Promise<boolean> {
    return this.load((signal) =>
      api.get<StorageAccess>(`/storage/buckets/${enc(bucket)}/access`, { signal }),
    );
  }
  add(bucket: string, template: TemplateId | null): Promise<DdlResult> {
    return api.post<DdlResult>(`/storage/buckets/${enc(bucket)}/access`, { template });
  }
  remove(bucket: string, name: string): Promise<DdlResult> {
    return api.delete<DdlResult>(`/storage/buckets/${enc(bucket)}/access/${enc(name)}`);
  }
}
