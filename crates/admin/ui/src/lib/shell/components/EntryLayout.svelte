<script lang="ts">
  import type { Snippet } from 'svelte'
  import Logo from './Logo.svelte'

  // The frame of the signed-out screens (loading, offline, login): the brand
  // stays in the same place while one hands over to the next.
  let { brand, actions, children }: { brand?: Snippet; actions?: Snippet; children: Snippet } = $props()
</script>

<div class="flex min-h-dvh flex-col bg-background px-4 py-4 sm:px-6 sm:py-6">
  <!-- The same bar as the signed-in panel: who this server is on the left,
       language and theme on the right (the account menu is not there yet). -->
  <header class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2 rounded-full bg-card py-1.5 ps-1.5 pe-4">
      <!-- On a phone the mark alone, so the project name has the room. -->
      <span class="flex shrink-0 sm:hidden"><Logo mark /></span>
      <span class="hidden shrink-0 sm:flex"><Logo /></span>
      {@render brand?.()}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
  </header>
  {@render children()}
</div>
