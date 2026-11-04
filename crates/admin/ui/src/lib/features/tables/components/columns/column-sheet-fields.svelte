<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import SqlPreview from "$lib/shared/schema/components/sql-preview.svelte";
  import type { ColumnDef, ColumnInfo, SqlPreview as Preview } from "$lib/shared/schema/model";
  import ColumnFields from "./column-fields.svelte";

  let {
    column = $bindable(),
    tables,
    original,
    preview,
  }: {
    column: ColumnDef;
    tables: Record<string, string[]>;
    original: ColumnInfo | null;
    preview: Preview;
  } = $props();
</script>

<ColumnFields bind:column {tables} mode={original ? "edit" : "add"} />
{#if original && column.data_type.trim() !== original.data_type}
  <p class="rounded-2xl bg-well px-4 py-3 text-sm text-muted-foreground">
    {t("tables.columnSheet.conversionBefore")}
    <code>{original.name}::{column.data_type}</code>. {t("tables.columnSheet.conversionAfter")}
  </p>
{/if}
<SqlPreview
  {preview}
  placeholder={original ? t("tables.columnSheet.previewEdit") : t("tables.columnSheet.previewAdd")}
/>
