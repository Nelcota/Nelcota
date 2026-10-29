<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, description, actions }: { title: string; description?: string; actions?: Snippet } =
    $props();
</script>

<div class="mb-6 grid items-start gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto]">
  <div class="grid min-w-0 gap-1">
    <h1 class="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
    {#if description}<p class="text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {description}
      </p>{/if}
  </div>
  {#if actions}
    <div class="flex flex-wrap items-center gap-2 sm:justify-end">{@render actions()}</div>
  {/if}
</div>
