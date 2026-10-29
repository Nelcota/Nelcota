<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import EmptyState from "$lib/components/shared/empty-state.svelte";
  import History from "@lucide/svelte/icons/history";
  import type { WebhookDeliveries, WebhookEndpoint } from "$lib/contracts/types";
  import { href } from "$lib/navigation/router.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { dateLabel, eventLabel, statuses, statusLabel, statusVariant } from "../format";
  let {
    data,
    endpoints,
    endpoint,
    status,
    hasCursor,
    loading = false,
    onfilter,
    onnext,
    onfirst,
  }: {
    data: WebhookDeliveries | null;
    endpoints: WebhookEndpoint[];
    endpoint: string;
    status: string;
    hasCursor: boolean;
    /** While a new page or filter loads, `data` still holds the previous one and its cursor. */
    loading?: boolean;
    onfilter: (endpoint: string, status: string) => void;
    onnext: () => void;
    onfirst: () => void;
  } = $props();
  const endpointName = $derived(
    endpoint !== ""
      ? (endpoints.find((hook) => hook.id === endpoint)?.name ?? endpoint)
      : t("webhooks.allWebhooks"),
  );
</script>

<div class="grid gap-4">
  <div class="flex flex-wrap gap-3">
    <Select.Root type="single" value={endpoint} onValueChange={(value) => onfilter(value, status)}>
      <Select.Trigger aria-label={t("webhooks.webhookFilter")} class="max-w-full min-w-0 bg-card"
        ><span class="truncate">{endpointName}</span></Select.Trigger
      >
      <Select.Content>
        <Select.Item value="" label={t("webhooks.allWebhooks")}
          >{t("webhooks.allWebhooks")}</Select.Item
        >
        {#each endpoints as hook (hook.id)}<Select.Item value={hook.id} label={hook.name}
            >{hook.name}</Select.Item
          >{/each}
        {#if endpoint && !endpoints.some((hook) => hook.id === endpoint)}<Select.Item
            value={endpoint}
            label={endpoint}>{endpoint}</Select.Item
          >{/if}
      </Select.Content>
    </Select.Root>
    <Select.Root type="single" value={status} onValueChange={(value) => onfilter(endpoint, value)}>
      <Select.Trigger aria-label={t("webhooks.statusFilter")} class="max-w-full bg-card"
        >{status ? statusLabel(status) : t("webhooks.allStatuses")}</Select.Trigger
      >
      <Select.Content>
        <Select.Item value="" label={t("webhooks.allStatuses")}
          >{t("webhooks.allStatuses")}</Select.Item
        >
        {#each statuses as value (value)}<Select.Item {value} label={statusLabel(value)}
            >{statusLabel(value)}</Select.Item
          >{/each}
      </Select.Content>
    </Select.Root>
  </div>
  {#if data?.deliveries.length}
    <!-- Phones get one tappable card per delivery: the result comes first and nothing scrolls sideways. -->
    <ul class="grid gap-2 sm:hidden">
      {#each data.deliveries as delivery (delivery.id)}
        <li>
          <a
            href={href(`/webhooks/deliveries/${delivery.id}`)}
            class="grid min-w-0 gap-2 rounded-3xl bg-card p-4 transition-colors hover:bg-accent"
          >
            <span class="flex items-center justify-between gap-2"
              ><Badge variant={statusVariant(delivery.status)}>{statusLabel(delivery.status)}</Badge
              ><span class="text-xs text-muted-foreground tabular-nums"
                >{t("webhooks.attemptsOf", {
                  done: delivery.attempts,
                  count: delivery.max_attempts,
                })}{delivery.last_status ? ` · HTTP ${delivery.last_status}` : ""}</span
              ></span
            >
            <span class="truncate font-medium">{delivery.endpoint_name}</span>
            <span class="text-xs text-muted-foreground"
              >{dateLabel(delivery.created_at)} · {eventLabel(delivery.event)}</span
            >
          </a>
        </li>
      {/each}
    </ul>
    <div class="overflow-x-auto rounded-3xl bg-card max-sm:hidden">
      <table class="w-full text-left text-sm">
        <thead
          ><tr class="border-b border-border text-muted-foreground"
            ><th class="p-4 font-medium">{t("webhooks.sent")}</th><th class="p-4 font-medium"
              >{t("webhooks.webhook")}</th
            ><th class="p-4 font-medium">{t("webhooks.event")}</th><th class="p-4 font-medium"
              >{t("webhooks.result")}</th
            ><th class="p-4"><span class="sr-only">{t("webhooks.view")}</span></th></tr
          ></thead
        >
        <tbody
          >{#each data.deliveries as delivery (delivery.id)}<tr
              class="border-b border-border/60 last:border-0"
            >
              <td class="p-4 whitespace-nowrap text-muted-foreground"
                >{dateLabel(delivery.created_at)}</td
              >
              <td class="max-w-64 p-4"
                ><p class="break-words font-medium">{delivery.endpoint_name}</p>
                <p class="mt-1 font-mono text-xs text-muted-foreground">
                  {delivery.schema}.{delivery.table}
                </p></td
              >
              <td class="p-4 whitespace-nowrap">{eventLabel(delivery.event)}</td>
              <td class="p-4"
                ><Badge variant={statusVariant(delivery.status)}
                  >{statusLabel(delivery.status)}</Badge
                >
                <p class="mt-1 text-xs text-muted-foreground">
                  {t("webhooks.attemptsOf", {
                    done: delivery.attempts,
                    count: delivery.max_attempts,
                  })}{delivery.last_status ? ` · HTTP ${delivery.last_status}` : ""}
                </p></td
              >
              <td class="p-4"
                ><Button
                  variant="outline"
                  size="sm"
                  href={href(`/webhooks/deliveries/${delivery.id}`)}>{t("webhooks.view")}</Button
                ></td
              >
            </tr>{/each}</tbody
        >
      </table>
    </div>
  {/if}
  {#if !data?.deliveries.length && data}<EmptyState
      class="rounded-3xl bg-card"
      icon={History}
      title={t("webhooks.noDeliveries")}
      description={t("webhooks.noDeliveriesHint")}
    />{/if}
  <!-- Like the users list: no pager while everything fits on one page. -->
  {#if hasCursor || data?.next_cursor}<div class="flex flex-wrap justify-end gap-2">
      {#if hasCursor}<Button variant="outline" size="sm" disabled={loading} onclick={onfirst}
          >{t("webhooks.firstPage")}</Button
        >{/if}
      <Button variant="outline" size="sm" disabled={loading || !data?.next_cursor} onclick={onnext}
        >{t("webhooks.nextPage")}</Button
      >
    </div>{/if}
  <p class="text-sm text-muted-foreground">{t("webhooks.retention")}</p>
</div>
