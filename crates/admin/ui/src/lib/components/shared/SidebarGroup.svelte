<script lang="ts">
  import type { Component, Snippet } from 'svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  // `nested` is a group inside another group (Tables inside Database): same size as the links beside it.
  let { label, icon: Icon, active, nested = false, children }: { label: string; icon: Component; active: boolean; nested?: boolean; children: Snippet } = $props()
  let open = $state(false)
  const id = $props.id()
  $effect(() => { if (active) open = true })
</script>

<div class="panel-nav-group">
  <button type="button" class={['panel-nav-link w-full text-left', nested && 'panel-nav-child']} class:is-parent-active={active} aria-expanded={open} aria-controls={id} onclick={() => (open = !open)}>
    <Icon class={['shrink-0', nested ? 'size-4' : 'size-[17px]']} strokeWidth={1.6} aria-hidden="true" />
    <span class="min-w-0 flex-1">{label}</span>
    <ChevronDown class={['size-3.5 shrink-0 transition-transform', !open && '-rotate-90']} aria-hidden="true" />
  </button>
  <div {id} class="panel-nav-children" hidden={!open}>{@render children()}</div>
</div>
