<script lang="ts">
  import { href } from '$lib/navigation/router.svelte'

  // Sibling pages as pills (D98), e.g. Users and User sign-in.
  let {
    tabs,
    current,
    label,
    fill = false,
  }: {
    tabs: { path: string; label: string }[]
    current: string
    label: string
    /** Spread the pills over the whole width (in a sidebar). */
    fill?: boolean
  } = $props()
</script>

<nav aria-label={label} class={['flex max-w-full items-center gap-1 overflow-x-auto rounded-lg p-1', fill ? 'w-full bg-well' : 'w-max bg-card']}>
  {#each tabs as tab (tab.path)}
    {@const active = tab.path === current}
    <a
      href={href(tab.path)}
      aria-current={active ? 'page' : undefined}
      class={[
        'flex h-9 items-center rounded-md text-sm whitespace-nowrap transition-colors',
        fill ? 'flex-1 justify-center px-2' : 'shrink-0 px-4',
        active ? 'bg-nav-active font-medium text-nav-active-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      ]}>{tab.label}</a
    >
  {/each}
</nav>
