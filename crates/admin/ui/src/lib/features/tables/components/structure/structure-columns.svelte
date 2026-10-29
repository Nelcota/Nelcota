<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Plus from "@lucide/svelte/icons/plus";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import type { ColumnInfo, Structure } from "$lib/shared/schema/ddl";
  import { t } from "$lib/i18n/index.svelte";

  let {
    structure,
    onadd,
    onedit,
    ondelete,
  }: {
    structure: Structure;
    onadd: () => void;
    onedit: (column: ColumnInfo) => void;
    ondelete: (column: ColumnInfo) => void;
  } = $props();

  const tag = "rounded-full bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground";
</script>

<section class="@container rounded-3xl bg-well">
  <header class="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
    <div class="min-w-0 flex-1 basis-60">
      <h2 class="text-base font-semibold">{t("tables.structure.columnsTitle")}</h2>
      <p class="text-sm text-muted-foreground">
        {t("tables.structure.columnsCount", { count: structure.columns.length })}
      </p>
    </div>
    <Button onclick={onadd}><Plus />{t("tables.structure.newColumn")}</Button>
  </header>
  <div class="divide-y">
    {#each structure.columns as column (column.name)}
      <div
        class="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 text-sm transition-colors hover:bg-muted/40 @3xl:grid-cols-[minmax(8rem,1fr)_minmax(6rem,1fr)_minmax(0,2fr)_auto]"
      >
        <div class="flex min-w-0 items-center gap-2">
          {#if column.primary_key}<KeyRound
              class="size-3.5 shrink-0 text-muted-foreground"
              aria-label={t("tables.structure.primaryKey")}
            />{/if}
          <span class="truncate font-mono text-sm font-medium">{column.name}</span>
        </div>
        <span
          class="col-start-1 row-start-2 truncate font-mono text-xs text-muted-foreground @3xl:col-start-auto @3xl:row-start-auto"
          >{column.data_type}</span
        >
        <div class="col-start-1 flex min-w-0 flex-wrap items-center gap-1.5 @3xl:col-start-auto">
          {#if column.identity}<span class={tag} title="identity"
              >{t("tables.structure.autoNumbered")}</span
            >{/if}
          {#if column.generated}<span class={tag}>{t("tables.structure.generated")}</span>{/if}
          {#if !column.nullable}<span class={tag}>{t("tables.structure.required")}</span>{/if}
          {#if column.unique}<span class={tag}>{t("tables.structure.unique")}</span>{/if}
          {#if column.references}
            <span class={tag}>→ {column.references.table}.{column.references.column}</span>
          {/if}
          {#if column.default && !column.identity && !column.generated}
            <span class="truncate font-mono text-2xs text-muted-foreground" title={column.default}
              >= {column.default}</span
            >
          {/if}
          {#if column.comment}<span class="truncate text-xs text-muted-foreground"
              >{column.comment}</span
            >{/if}
        </div>
        <div
          class="col-start-2 row-start-1 row-span-3 flex justify-end gap-1 @3xl:col-start-auto @3xl:row-start-auto @3xl:row-span-1"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("tables.structure.edit", { name: column.name })}
            onclick={() => onedit(column)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("tables.structure.delete", { name: column.name })}
            onclick={() => ondelete(column)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    {/each}
  </div>
</section>
