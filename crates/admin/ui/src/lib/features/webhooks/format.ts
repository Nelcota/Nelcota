import { dateText } from '$lib/formatting/date'
import { numberFormat } from '$lib/formatting/intl'
import { hasMessage, intlLocale, translate, i18n, t } from '$lib/i18n/index.svelte'
import type { WebhookDelivery } from '$lib/contracts/types'

export const statuses = ['pending', 'processing', 'succeeded', 'failed', 'cancelled'] as const
export const statusLabel = (value: string) => statuses.includes(value as typeof statuses[number]) ? translate(i18n.locale, `webhooks.status.${value}`) : value
export const failureLabel = (value: string | null) => value && hasMessage(`webhooks.failures.${value}`) ? translate(i18n.locale, `webhooks.failures.${value}`) : value ?? ''
export const eventLabel = (value: string) => value === 'INSERT' ? t('webhooks.insert') : value === 'UPDATE' ? t('webhooks.update') : t('webhooks.delete')
export const dateLabel = (value: string | null) => dateText(value, date => date.toLocaleString(intlLocale()))
export const canReplay = (delivery: WebhookDelivery) => delivery.endpoint_enabled && ['failed', 'succeeded'].includes(delivery.status) && delivery.last_error !== 'payload_too_large'
export const statusClass = (value: string) => value === 'succeeded' ? 'bg-success/10 text-success' : value === 'failed' ? 'bg-destructive/10 text-destructive' : value === 'pending' || value === 'processing' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'
/** Milliseconds below one second, seconds (one decimal at most) from there on: "250 ms", "10 s". */
export function durationLabel(ms: number | null) {
  if (ms === null) return '—'
  if (ms < 1000) return `${numberFormat(intlLocale()).format(ms)} ms`
  return `${numberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(ms / 1000)} s`
}
