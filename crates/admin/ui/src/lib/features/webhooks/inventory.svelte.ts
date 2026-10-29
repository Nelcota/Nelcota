import type { WebhookEndpoints, WebhookDeliveries } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";

import { webhooks } from "./api.js";
export type { WebhookEndpoint, WebhookSecret } from "$lib/contracts/types";

/** Keeps endpoint configuration and filtered delivery history independently cancellable. */
export class WebhookInventory {
  readonly config = new RemoteResource<WebhookEndpoints>();
  readonly history = new RemoteResource<WebhookDeliveries>();
  loadConfig(): Promise<boolean> {
    return this.config.load((signal) => webhooks.list(signal));
  }
  loadHistory(query: string): Promise<boolean> {
    return this.history.load((signal) => webhooks.history(query, signal));
  }
}
