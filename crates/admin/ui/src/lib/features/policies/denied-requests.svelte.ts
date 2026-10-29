import type { DeniedRequests } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api } from "$lib/transport/api";
export type { DeniedRequest } from "$lib/contracts/types";

/** Publishes only the newest centrally validated denied-request inventory. */
export class DeniedRequestLog extends RemoteResource<DeniedRequests> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<DeniedRequests>("/denied", { signal }));
  }
}
