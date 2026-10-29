import { expect, type Route } from "@playwright/test";

import { base, host, plan, digest } from "./host-fixture";
import { requestObject } from "./request-json";
type Mode = "lost-response" | "acknowledged";

/** Reconciles one accepted creation request through status, including a lost start response. */
export class CreationReceipt {
  starts = 0;
  private accepted: Record<string, unknown> | null = null;
  constructor(private readonly mode: Mode) {}
  async handle(route: Route): Promise<void> {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (this.mode === "lost-response")
      expect(route.request().headers()["x-nelcota-updates"]).toBe("1");
    switch (body.action) {
      case "host_status":
        await route.fulfill({ json: { result: "host_status", data: this.status(body) } });
        return;
      case "host_plan":
        await route.fulfill({
          json: { result: "host_plan", data: plan(body.operation, "CREATE reporting") },
        });
        return;
      case "host_start":
        await this.start(route, body);
        return;
      default:
        throw new Error("Unexpected action", { cause: body.action });
    }
  }
  private status(body: Record<string, unknown>) {
    const keyed = typeof body.key === "string" && body.key !== "";
    return {
      ...host,
      receipt: keyed ? this.accepted : null,
      jobs: this.jobs(keyed),
    };
  }
  private jobs(keyed: boolean) {
    if (this.mode === "lost-response" && keyed) return [];
    return this.accepted === null ? [] : [this.accepted];
  }
  private async start(route: Route, body: Record<string, unknown>): Promise<void> {
    this.starts++;
    if (this.mode === "lost-response") expect(body.confirmation).toBe("CREATE reporting");
    const operation =
      this.mode === "acknowledged" ? (body.operation ?? creationOperation()) : creationOperation();
    this.accepted = {
      id: digest,
      request_key: body.key,
      operation,
      stage: this.mode === "lost-response" ? "starting" : "completed",
      sequence: this.mode === "lost-response" ? 4 : 7,
      updated_at: 123,
      changed: true,
      backup: null,
      error: null,
      last_stage: null,
    };
    if (this.mode === "lost-response") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { result: "host_job", data: this.accepted } });
  }
}
function creationOperation() {
  return { kind: "create", project: "reporting", domain: "api.reporting.test", profile: "1gb" };
}
