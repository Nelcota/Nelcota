import type { Overview, MetricsResponse, DeniedRequests } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api } from "$lib/transport/api";

/** Owns independent inventory, metrics and refusal requests for the dashboard. */
export class OverviewResources {
  readonly overview = new RemoteResource<Overview>();
  readonly metrics = new RemoteResource<MetricsResponse>();
  readonly denied = new RemoteResource<DeniedRequests>();
  loadOverview(): Promise<boolean> {
    return this.overview.load((signal) => api.get<Overview>("/overview", { signal }));
  }
  loadMetrics(range: "1h" | "24h"): Promise<boolean> {
    return this.metrics.load((signal) =>
      api.get<MetricsResponse>(`/metrics?range=${range}`, { signal }),
    );
  }
  loadDenied(): Promise<boolean> {
    return this.denied.load((signal) => api.get<DeniedRequests>("/denied", { signal }));
  }
}
