<script lang="ts">
  import type { Cursor } from "./code-editor.svelte";
  import { t } from "$lib/i18n/index.svelte";

  let { cursor, shortcut }: { cursor: Cursor; shortcut: string } = $props();

  const selected = $derived(cursor.to - cursor.from);
</script>

<!-- Where the cursor is, what Ctrl+Enter will run and the limits of a run. -->
<div
  class="flex h-8 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground"
  role="status"
>
  <span class="tabular-nums"
    >{t("sql.status.position", { line: cursor.line, column: cursor.column })}</span
  >
  {#if selected > 0}<span class="tabular-nums text-foreground"
      >{t("sql.status.selected", { count: selected })}</span
    >{/if}
  <span class="ml-auto hidden sm:inline"
    >{selected > 0
      ? t("sql.status.runSelection", { shortcut })
      : t("sql.status.run", { shortcut })}</span
  >
  <span class="hidden md:inline">{t("sql.status.limits")}</span>
</div>
