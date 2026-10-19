<script lang="ts">
  import type { RlsState } from '$lib/contracts/types'

  let { state }: { state: RlsState } = $props()
</script>

<!-- Only shows when there is something to fix. -->
{#if (state === 'danger' || state === 'warn')}
  <span class={['size-1.5 shrink-0 rounded-full', state === 'danger' ? 'bg-destructive' : 'bg-warning']}></span>
{/if}
{#if !(state === 'danger' || state === 'warn')}
  <span class="size-1.5 shrink-0"></span>
{/if}
