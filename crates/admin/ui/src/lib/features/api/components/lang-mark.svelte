<script lang="ts">
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import type { Lang } from "$lib/features/api/api-examples";

  // The language's mark beside its name on the example switch: the TypeScript
  // and JavaScript squares, and a terminal for curl (it has no common mark).
  let { lang }: { lang: Lang } = $props();
</script>

{#if lang === "curl"}
  <SquareTerminal class="size-4 shrink-0" aria-hidden="true" />
{/if}
{#if !(lang === "curl")}
  <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
    <rect width="16" height="16" rx="3" fill={lang === "ts" ? "#3178C6" : "#F7DF1E"} />
    <text
      x="14.2"
      y="13.6"
      text-anchor="end"
      font-family="ui-sans-serif, system-ui, sans-serif"
      font-size="7.6"
      font-weight="700"
      fill={lang === "ts" ? "#fff" : "#000"}>{lang === "ts" ? "TS" : "JS"}</text
    >
  </svg>
{/if}
