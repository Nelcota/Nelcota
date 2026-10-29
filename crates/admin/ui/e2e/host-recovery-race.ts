import type { Route } from "@playwright/test";
import { expect } from "@playwright/test";

import { gate } from "./gate";
import { base, host, plan } from "./host-fixture";
import { requestObject, jsonString } from "./request-json";
/** Holds old status reads independently of the current rejected creation key. */
export class RecoveryRace {
  readonly old = gate();
  readonly current = gate();
  reads = 0;
  starts = 0;
  currentKey: string | null = null;
  async handle(route: Route): Promise<void> {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      this.reads++;
      if (this.reads === 2) {
        expect(body.key).toBeNull();
        await this.old.promise;
      }
      if (this.reads >= 3 && Boolean(body.key)) {
        this.currentKey = jsonString(body.key);
        await this.current.promise;
      }
      await route.fulfill({ json: { result: "host_status", data: host } }).catch(() => {});
      return;
    }
    if (body.action === "host_plan") {
      await route.fulfill({
        json: {
          result: "host_plan",
          data: plan(body.operation, "CREATE reporting"),
        },
      });
      return;
    }
    if (body.action === "host_start") {
      this.starts++;
      await route.fulfill({
        status: 403,
        json: { code: "reauthentication_failed" },
      });
      return;
    }
    throw new Error("Unexpected action", { cause: body.action });
  }
}
