<script lang="ts">
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Plus from "@lucide/svelte/icons/plus";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import { Button } from "$lib/components/ui/button";
  import { href } from "$lib/navigation/router.svelte";
  import type { AttentionItem } from "$lib/features/policies/attention";
  import { t } from "$lib/i18n/index.svelte";

  // List outstanding problems with their fixes beside them,
  // without requiring a search for the table farther down.
  let {
    items,
    enabling,
    onenable,
    oncreate,
  }: {
    items: readonly AttentionItem[];
    /** The table whose protection is currently being enabled. */
    enabling: string | null;
    onenable: (table: string) => void;
    oncreate: (table: string) => void;
  } = $props();

  function explanation(item: AttentionItem): string {
    if (item.kind === "unprotected") return t("policies.attention.unprotected");
    if (item.kind === "noRules") return t("policies.attention.noRules");
    if (item.kind === "ownerView") return t("policies.ownerViewHint");
    return t("policies.exposedRelations", { relations: item.table });
  }
</script>

<section
  class="grid gap-4 rounded-3xl border border-warning/30 bg-card p-5 sm:p-6"
  aria-labelledby="policies-attention"
>
  <div class="grid gap-1">
    <h2 id="policies-attention" class="text-lg font-semibold">
      {t("policies.attention.title", { count: items.length })}
    </h2>
    <p class="text-sm text-muted-foreground">{t("policies.attention.hint")}</p>
  </div>
  <ul class="grid divide-y">
    {#each items as item (`${item.kind}-${item.table}`)}
      <li class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
        <span
          class={[
            "size-2.5 shrink-0 rounded-full",
            item.kind === "noRules" ? "bg-warning" : "bg-destructive",
          ]}
          aria-hidden="true"
        ></span>
        <div class="grid min-w-0 flex-1 basis-64 gap-0.5">
          <p class="text-base font-semibold [overflow-wrap:anywhere]">{item.table}</p>
          <p class="text-sm text-muted-foreground">{explanation(item)}</p>
        </div>
        {#if item.kind === "unprotected"}
          <Button size="sm" disabled={enabling !== null} onclick={() => onenable(item.table)}>
            {#if enabling === item.table}<LoaderCircle
                data-icon="inline-start"
                class="animate-spin"
                aria-hidden="true"
              />{/if}
            {#if enabling !== item.table}<ShieldCheck
                data-icon="inline-start"
                aria-hidden="true"
              />{/if}
            {t("policies.enableRls")}
          </Button>
        {/if}
        {#if item.kind === "noRules"}
          <Button size="sm" onclick={() => oncreate(item.table)}
            ><Plus data-icon="inline-start" aria-hidden="true" />{t(
              "policies.attention.createRule",
            )}</Button
          >
        {/if}
        {#if item.kind === "ownerView" || item.kind === "relation"}
          <Button size="sm" variant="outline" href={href("/sql")}
            ><SquareTerminal data-icon="inline-start" aria-hidden="true" />{t(
              "policies.reviewSql",
            )}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>
