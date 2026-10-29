<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import Plus from "@lucide/svelte/icons/plus";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Rows3 from "@lucide/svelte/icons/rows-3";
  import EmptyState from "$lib/components/shared/empty-state.svelte";
  import { t } from "$lib/i18n/index.svelte";

  // Grid states without rows to show: first load, error, a filter without
  // results and an empty table.
  let {
    state,
    message = "",
    insertable = false,
    table = "",
    onretry,
    onclearfilters,
    oninsert,
  }: {
    state: "loading" | "error" | "no-match" | "empty";
    message?: string;
    insertable?: boolean;
    table?: string;
    onretry?: () => void;
    onclearfilters?: () => void;
    oninsert?: () => void;
  } = $props();
</script>

{#if state === "loading"}
  <div class="grid gap-px p-0" aria-busy="true" aria-label={t("tables.state.loading")}>
    <div class="flex gap-3 border-b px-4 py-3.5">
      {#each [1, 2, 3, 4, 5] as i (i)}<Skeleton class="h-6 w-32" />{/each}
    </div>
    {#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
      <div class="flex gap-3 border-b px-4 py-3">
        {#each [1, 2, 3, 4, 5] as j (j)}<Skeleton
            class={["h-4", j === 1 ? "w-12" : "w-32"]}
          />{/each}
      </div>
    {/each}
  </div>
{/if}
{#if !(state === "loading") && state === "error"}
  <div class="grid justify-items-start gap-3 p-6 text-sm">
    <p class="break-words text-destructive">{t("tables.state.loadError", { message })}</p>
    {#if onretry}<Button variant="outline" size="sm" onclick={onretry}
        ><RotateCw />{t("common.retry")}</Button
      >{/if}
  </div>
{/if}
{#if !(state === "loading") && !(state === "error") && state === "no-match"}
  <EmptyState class="py-20" title={t("tables.state.noMatch")}>
    {#snippet actions()}
      {#if onclearfilters}<Button variant="outline" onclick={onclearfilters}
          >{t("tables.state.clearFilters")}</Button
        >{/if}
    {/snippet}
  </EmptyState>
{/if}
{#if !(state === "loading") && !(state === "error") && !(state === "no-match")}
  <EmptyState
    class="py-20"
    icon={Rows3}
    title={t("tables.state.empty")}
    description={t(insertable ? "tables.state.emptyHint" : "tables.state.emptyReadOnly", { table })}
  >
    {#snippet actions()}
      {#if insertable && oninsert}<Button onclick={oninsert}
          ><Plus />{t("tables.state.insertFirst")}</Button
        >{/if}
    {/snippet}
  </EmptyState>
{/if}
