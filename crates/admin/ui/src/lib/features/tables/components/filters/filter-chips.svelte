<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import X from "@lucide/svelte/icons/x";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import { describe, type TableFilter } from "$lib/features/tables/filters";
  import { t } from "$lib/i18n/index.svelte";

  let {
    filters,
    sort,
    onchange,
    onclearsort,
  }: {
    filters: TableFilter[];
    sort: { column: string; desc: boolean } | null;
    onchange: (filters: TableFilter[]) => void;
    onclearsort: () => void;
  } = $props();

  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-card pr-1 pl-2.5 text-xs";
  const remove =
    "grid size-5 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
</script>

<!-- What is shaping the grid (order and filters), each removable. -->
<div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
  {#if sort}
    <span class={chip}>
      {#if sort.desc}<ArrowDown class="size-3 text-muted-foreground" />{/if}
      {#if !sort.desc}<ArrowUp class="size-3 text-muted-foreground" />{/if}
      {t("tables.filters.sortedBy")} <span class="font-mono">{sort.column}</span>
      <button class={remove} aria-label={t("tables.filters.clearSort")} onclick={onclearsort}
        ><X class="size-3" /></button
      >
    </span>
  {/if}
  {#each filters as filter, i (i)}
    <span class={[chip, "font-mono"]}>
      {describe(filter)}
      <button
        class={remove}
        aria-label={t("tables.filters.remove")}
        onclick={() => onchange(filters.filter((_, j) => j !== i))}><X class="size-3" /></button
      >
    </span>
  {/each}
  {#if filters.length}
    <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={() => onchange([])}
      >{t("tables.filters.clearFilters")}</Button
    >
  {/if}
</div>
