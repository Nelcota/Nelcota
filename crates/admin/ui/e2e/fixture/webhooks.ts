import type { Page, Request, Route } from "@playwright/test";

import { requiredValue } from "../../src/lib/contracts/required-value.js";
import { fixture } from "../fixtures.js";
import { requestObject } from "../request-json.js";
const stamp = "2026-10-11T12:00:00Z";
export const endpointId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
export const secret = `whsec_${"a".repeat(64)}`;
export const deliveryId = "9223372036854775800";
type Hook = {
  id: string;
  name: string;
  schema: string;
  table: string;
  table_available: boolean;
  url: string;
  events: string[];
  enabled: boolean;
  max_attempts: number;
  created_at: string;
};
export const initial: Hook = {
  id: endpointId,
  name: "Pedidos pagos",
  schema: "public",
  table: "notes",
  table_available: true,
  url: "https://example.com/hook",
  events: ["INSERT", "UPDATE"],
  enabled: true,
  max_attempts: 6,
  created_at: stamp,
};
type Reply = (json: unknown) => Promise<void>;
class WebhooksFixture {
  #hooks: Hook[];
  #resent = false;
  readonly writes: { method: string; path: string; body: unknown }[] = [];
  readonly historyQueries: string[] = [];
  constructor(empty: boolean) {
    this.#hooks = empty ? [] : [{ ...initial }];
  }
  #delivery() {
    return {
      id: deliveryId,
      endpoint_id: endpointId,
      endpoint_name: initial.name,
      endpoint_enabled: this.#hooks[0]?.enabled ?? false,
      event_id: eventId,
      replay_of: null,
      schema: "public",
      table: "notes",
      event: "UPDATE",
      url: initial.url,
      status: "failed",
      attempts: 2,
      max_attempts: 6,
      created_at: stamp,
      next_attempt_at: null,
      finished_at: stamp,
      last_status: 503,
      last_error: "http_error",
    };
  }
  #detail(path: string) {
    const replay = path.endsWith("5801");
    return {
      delivery: replay
        ? {
            ...this.#delivery(),
            id: "9223372036854775801",
            status: "pending",
            attempts: 0,
            last_status: null,
            last_error: null,
            finished_at: null,
            next_attempt_at: stamp,
            replay_of: deliveryId,
          }
        : this.#delivery(),
      payload: JSON.stringify({
        id: eventId,
        type: "UPDATE",
        record: { title: "<script>window.webhookXss = true</script>" },
      }),
      attempts: replay
        ? []
        : [
            {
              number: 2,
              started_at: stamp,
              finished_at: stamp,
              status_code: 503,
              duration_ms: 25,
              error: "http_error",
            },
            {
              number: 1,
              started_at: stamp,
              finished_at: stamp,
              status_code: null,
              duration_ms: null,
              error: "worker_interrupted",
            },
          ],
    };
  }
  async #collection(request: Request, reply: Reply): Promise<void> {
    if (request.method() === "GET")
      return await reply({
        endpoints: this.#hooks,
        tables: ["notes", "orders"],
        allow_loopback: false,
        outstanding: this.#resent ? 1 : 0,
        retained: this.#resent ? 2 : 1,
      });
    if (request.method() !== "POST") throw new Error("Unexpected webhook collection method");
    const input = requestObject(request) as Omit<
      Hook,
      "id" | "schema" | "table_available" | "created_at"
    >;
    const endpoint = { ...initial, ...input };
    this.#hooks = [endpoint];
    await reply({ endpoint, secret });
  }
  async #endpoint(route: Route, reply: Reply): Promise<void> {
    const request = route.request();
    if (request.method() === "PUT") {
      this.#hooks = [
        { ...requiredValue(this.#hooks[0], "webhook fixture"), ...requestObject(request) },
      ];
      await reply(this.#hooks[0]);
      return;
    }
    if (request.method() !== "DELETE") throw new Error("Unexpected webhook endpoint method");
    this.#hooks = [];
    await route.fulfill({ status: 204 });
  }
  async #history(request: Request, url: URL, reply: Reply): Promise<void> {
    if (request.method() === "DELETE") {
      await reply({ deleted: 1 });
      return;
    }
    this.historyQueries.push(url.search);
    await reply({
      deliveries: [this.#delivery()],
      next_cursor: url.searchParams.has("before") ? null : "50",
    });
  }
  async handle(route: Route): Promise<void> {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.slice("/admin/api".length);
    if (request.method() !== "GET") {
      const body: unknown = request.postDataJSON();
      this.writes.push({ method: request.method(), path, body });
    }
    const reply: Reply = (json) => route.fulfill({ status: 200, json });
    if (path === "/webhooks") return await this.#collection(request, reply);
    if (path === `/webhooks/${endpointId}`) return await this.#endpoint(route, reply);
    if (path === `/webhooks/${endpointId}/rotate`)
      return await reply({ endpoint: this.#hooks[0], secret });
    if (path === "/webhooks/deliveries") return await this.#history(request, url, reply);
    if (path === `/webhooks/deliveries/${deliveryId}/replay`) {
      this.#resent = true;
      await reply({ id: "9223372036854775801" });
      return;
    }
    if (path.startsWith("/webhooks/deliveries/")) return await reply(this.#detail(path));
    await route.fulfill({ status: 404, json: { code: "webhook_not_found", error: "Not found" } });
  }
}
export async function setupWebhooks(page: Page, empty = false) {
  await fixture(page);
  const state = new WebhooksFixture(empty);
  await page.route("**/admin/api/webhooks**", (route) => state.handle(route));
  await page.goto("/admin/webhooks");
  return { writes: state.writes, historyQueries: state.historyQueries };
}
