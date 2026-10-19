<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import History from '@lucide/svelte/icons/history'
  import type { WebhookDeliveries, WebhookEndpoint } from '$lib/contracts/types'
  import { href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import { dateLabel, eventLabel, statuses, statusLabel, statusClass } from '../format'
  let { data, endpoints, endpoint, status, hasCursor, onfilter, onnext, onfirst }: {
    data: WebhookDeliveries | null; endpoints: WebhookEndpoint[]; endpoint: string; status: string; hasCursor: boolean
    onfilter: (endpoint: string, status: string) => void; onnext: () => void; onfirst: () => void
  } = $props()
</script>
<div class="grid gap-4">
  <div class="flex flex-wrap gap-3">
    <select aria-label={t('webhooks.webhookFilter')} value={endpoint} onchange={event => onfilter(event.currentTarget.value, status)} class="h-10 max-w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm">
      <option value="">{t('webhooks.allWebhooks')}</option>
      {#each endpoints as hook}<option value={hook.id}>{hook.name}</option>{/each}
      {#if endpoint && !endpoints.some(hook => hook.id === endpoint)}<option value={endpoint}>{endpoint}</option>{/if}
    </select>
    <select aria-label={t('webhooks.statusFilter')} value={status} onchange={event => onfilter(endpoint, event.currentTarget.value)} class="h-10 max-w-full rounded-xl border border-input bg-card px-3 text-sm">
      <option value="">{t('webhooks.allStatuses')}</option>{#each statuses as value}<option value={value}>{statusLabel(value)}</option>{/each}
    </select>
  </div>
  {#if (data?.deliveries.length)}
    <div class="overflow-x-auto rounded-3xl bg-card">
      <table class="w-full text-left text-sm"><thead><tr class="border-b border-border text-muted-foreground"><th class="p-4 font-medium">{t('webhooks.sent')}</th><th class="p-4 font-medium">{t('webhooks.configuration')}</th><th class="p-4 font-medium">{t('webhooks.event')}</th><th class="p-4 font-medium">{t('webhooks.result')}</th><th class="p-4"><span class="sr-only">{t('webhooks.view')}</span></th></tr></thead>
        <tbody>{#each data.deliveries as delivery (delivery.id)}<tr class="border-b border-border/60 last:border-0">
          <td class="p-4 whitespace-nowrap text-muted-foreground">{dateLabel(delivery.created_at)}</td>
          <td class="max-w-64 p-4"><p class="break-words font-medium">{delivery.endpoint_name}</p><p class="mt-1 font-mono text-xs text-muted-foreground">{delivery.schema}.{delivery.table}</p></td>
          <td class="p-4 whitespace-nowrap">{eventLabel(delivery.event)}</td>
          <td class="p-4"><span class={['inline-block rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap', statusClass(delivery.status)]}>{statusLabel(delivery.status)}</span><p class="mt-1 text-xs text-muted-foreground">{delivery.attempts}/{delivery.max_attempts}{delivery.last_status ? ` · HTTP ${delivery.last_status}` : ''}</p></td>
          <td class="p-4"><Button variant="outline" size="sm" href={href(`/webhooks/deliveries/${delivery.id}`)}>{t('webhooks.view')}</Button></td>
        </tr>{/each}</tbody>
      </table>
    </div>
  {/if}
  {#if !(data?.deliveries.length) && (data)}<EmptyState class="rounded-3xl bg-card" icon={History} title={t('webhooks.noDeliveries')} description={t('webhooks.noDeliveriesHint')} />{/if}
  <div class="flex flex-wrap justify-end gap-2">
    {#if hasCursor}<Button variant="outline" onclick={onfirst}>{t('webhooks.firstPage')}</Button>{/if}
    <Button variant="outline" disabled={!data?.next_cursor} onclick={onnext}>{t('webhooks.nextPage')}</Button>
  </div>
  <p class="text-sm text-muted-foreground">{t('webhooks.retention')}</p>
</div>
