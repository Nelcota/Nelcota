import type {
  WebhookEndpoint,
  WebhookSecret,
  WebhookEndpoints,
  WebhookDeliveries,
  WebhookDetail,
  WebhookReplay,
} from "$lib/contracts/types";
import { api, enc } from "$lib/transport/api";

export type EndpointInput = Pick<
  WebhookEndpoint,
  "name" | "table" | "url" | "events" | "enabled" | "max_attempts"
>;
export const webhooks = {
  list: (signal?: AbortSignal) => api.get<WebhookEndpoints>("/webhooks", { signal }),
  history: (query: string, signal?: AbortSignal) =>
    api.get<WebhookDeliveries>(`/webhooks/deliveries${query}`, { signal }),
  detail: (id: string, signal?: AbortSignal) =>
    api.get<WebhookDetail>(`/webhooks/deliveries/${enc(id)}`, { signal }),
  create: (input: EndpointInput) => api.post<WebhookSecret>("/webhooks", input),
  update: (id: string, input: EndpointInput) =>
    api.put<WebhookEndpoint>(`/webhooks/${enc(id)}`, input),
  remove: (id: string) => api.delete(`/webhooks/${enc(id)}`),
  rotate: (id: string) => api.post<WebhookSecret>(`/webhooks/${enc(id)}/rotate`),
  replay: (id: string) => api.post<WebhookReplay>(`/webhooks/deliveries/${enc(id)}/replay`),
  clear: () => api.delete("/webhooks/deliveries"),
};
