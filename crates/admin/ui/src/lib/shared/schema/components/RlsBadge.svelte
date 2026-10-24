<script lang="ts">
  import type { Rls } from '$lib/contracts/types'
  import { t } from '$lib/i18n/index.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { technical } from '$lib/shared/schema/technical.svelte'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import ShieldAlert from '@lucide/svelte/icons/shield-alert'
  import ShieldOff from '@lucide/svelte/icons/shield-off'
  import Rows3 from '@lucide/svelte/icons/rows-3'

  let { rls }: { rls: Rls } = $props()

  type State = 'ok' | 'warn' | 'danger' | 'none' | 'view'
  const state = $derived((['ok', 'warn', 'danger', 'none', 'view'].includes(rls.state) ? rls.state : 'view') as State)
  const ownerView = $derived(rls.label === 'view owner privileges')

  // The Postgres view of the same state (D93: technical on demand).
  const technicalLabel = $derived.by(() => {
    switch (state) {
      case 'danger':
        return t('policies.rls.none')
      case 'warn':
        return t('policies.rls.noPolicies')
      case 'ok':
        return t('policies.rls.policies', { count: rls.policies })
      case 'none':
        return t('policies.rls.noGrants')
      default:
        return t('policies.rls.view')
    }
  })
  const label = $derived(ownerView ? t('policies.ownerView') : technical.on ? technicalLabel : t(`policies.plain.state.${state}`))
  const hint = $derived(ownerView ? t('policies.ownerViewHint') : `${t(`policies.plain.stateHint.${state}`)} (${technicalLabel})`)
</script>

<!-- Access states keep semantic colours independent of action accents. -->
<!-- The hint opens on keyboard focus too; `relative` lifts it above card-wide link overlays. -->
<Tooltip.Root>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      <Badge
        {...props}
        variant="outline"
        tabindex={0}
        class={[
          'relative cursor-help gap-1 whitespace-nowrap',
          state === 'danger' && 'border-destructive/30 bg-destructive/10 text-destructive',
          state === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
          state === 'ok' && 'border-success/25 bg-success/5 text-success',
          (state === 'none' || state === 'view') && 'border-border-strong bg-muted text-muted-foreground',
        ]}
      >
        {#if (state === 'ok')}<ShieldCheck aria-hidden="true" />{/if}
        {#if !(state === 'ok') && (state === 'warn' || state === 'danger')}<ShieldAlert aria-hidden="true" />{/if}
        {#if !(state === 'ok') && !(state === 'warn' || state === 'danger') && (state === 'view')}<Rows3 aria-hidden="true" />{/if}
        {#if !(state === 'ok') && !(state === 'warn' || state === 'danger') && !(state === 'view')}<ShieldOff aria-hidden="true" />{/if}
        {label}
      </Badge>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content>{hint}</Tooltip.Content>
</Tooltip.Root>
