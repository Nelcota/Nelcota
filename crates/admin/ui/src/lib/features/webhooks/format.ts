import type { WebhookDelivery } from "$lib/contracts/types";
import { dateText } from "$lib/formatting/date";
import { numberFormat } from "$lib/formatting/intl";
import { hasMessage, intlLocale, translate, i18n, t } from "$lib/i18n/index.svelte";
const SECOND_IN_MS = 1000;

export const statuses = ["pending", "processing", "succeeded", "failed", "cancelled"] as const;
export const statusLabel = (value: string) =>
  statuses.includes(value as (typeof statuses)[number])
    ? translate(i18n.locale, `webhooks.status.${value}`)
    : value;
export const failureLabel = (value: string | null) =>
  value != null && value !== "" && hasMessage(`webhooks.failures.${value}`)
    ? translate(i18n.locale, `webhooks.failures.${value}`)
    : (value ?? "");
export function eventLabel(value: string): string {
  if (value === "INSERT") return t("webhooks.insert");
  if (value === "UPDATE") return t("webhooks.update");
  return t("webhooks.delete");
}
export const dateLabel = (value: string | null) =>
  dateText(value, (date) => date.toLocaleString(intlLocale()));
export const canReplay = (delivery: WebhookDelivery) =>
  delivery.endpoint_enabled &&
  ["failed", "succeeded"].includes(delivery.status) &&
  delivery.last_error !== "payload_too_large" &&
  delivery.last_error !== "queue_full";
export function statusVariant(value: string): "success" | "destructive" | "warning" | "muted" {
  if (value === "succeeded") return "success";
  if (value === "failed") return "destructive";
  if (value === "pending" || value === "processing") return "warning";
  return "muted";
}
/** Milliseconds below one second, seconds (one decimal at most) from there on: "250 ms", "10 s". */
export function durationLabel(ms: number | null) {
  if (ms === null) return "—";
  if (ms < SECOND_IN_MS) return `${numberFormat(intlLocale()).format(ms)} ms`;
  return `${numberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(ms / SECOND_IN_MS)} s`;
}
