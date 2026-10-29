import { downloadText } from "$lib/browser/download";
import type { MetricsResponse } from "$lib/contracts/types";
import { toCsv } from "$lib/formatting/tabular";

/** Downloads the displayed traffic range with stable CSV columns and explicit null latency. */
export function downloadTraffic(traffic: MetricsResponse | null, range: "1h" | "24h"): void {
  if (traffic === null) return;
  const rows = traffic.points.map((point) => [
    point.at,
    String(point.requests),
    String(point.refused),
    String(point.errors),
    point.p95_ms === null ? null : String(point.p95_ms),
  ]);
  downloadText(
    `nelcota-traffic-${range}.csv`,
    toCsv(["at", "requests", "refused", "errors", "p95_ms"], rows),
    "text/csv",
  );
}
