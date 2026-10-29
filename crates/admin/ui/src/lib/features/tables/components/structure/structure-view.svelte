<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { toast } from "svelte-sonner";
  import { StructureColumns, TableSettings, DropTableDialog } from "./surfaces.js";
  import ColumnSheet from "../columns/column-sheet.svelte";
  import { ConfirmDialog, LoadError } from "$lib/components/shared";

  import { ddl, type AlterAction, type ColumnInfo, type Structure } from "$lib/shared/schema/ddl";
  import { isAbort } from "$lib/transport/api";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  let {
    name,
    policies,
    onrenamed,
    ondropped,
    onaltered,
  }: {
    name: string;
    /** Policies on the table, when the table list knows it. */
    policies?: number;
    /** The table was renamed: the editor switches the URL. */
    onrenamed: (name: string) => void;
    ondropped: () => void;
    /** Something else changed (RLS, grants): the table list's status may be stale. */
    onaltered?: () => void;
  } = $props();

  let structure = $state<Structure | null>(null);
  let error = $state("");
  let loading = $state(true);
  let inflight: AbortController | undefined;
  let columnOpen = $state(false);
  let editing = $state<ColumnInfo | null>(null);
  let toDelete = $state<ColumnInfo | null>(null);
  let deleteOpen = $state(false);
  let dropOpen = $state(false);
  let active = true;
  onDestroy(() => {
    active = false;
  });

  function currentRequest(controller: AbortController): boolean {
    return active && inflight === controller && controller.signal.aborted === false;
  }
  function currentTable(target: string): boolean {
    return active && name === target;
  }
  async function load() {
    if (Boolean(active) === false) return;
    inflight?.abort();
    const controller = (inflight = new AbortController());
    if (structure?.name !== name) structure = null;
    loading = true;
    error = "";
    try {
      const result = await ddl.structure(name, { signal: controller.signal });
      if (currentRequest(controller) === false) return;
      structure = result;
      error = "";
    } catch (e) {
      if (currentRequest(controller) && Boolean(isAbort(e)) === false) error = errorMessage(e);
    } finally {
      if (inflight === controller) loading = false;
    }
  }

  $effect(() => {
    void name;
    void untrack(load);
    return () => inflight?.abort();
  });

  /** Single point of change: applies, notifies and reloads (or follows the rename). */
  async function alter(actions: AlterAction[]) {
    if (Boolean(active) === false || actions.length === 0) return;
    const target = name;
    try {
      await ddl.alterTable(target, actions);
      if (currentTable(target) === false) return;
      toast.success(t("tables.toast.tableAltered"));
      const renamed = actions.findLast((a) => a.action === "rename_table");
      if (renamed != null) {
        onrenamed(renamed.name);
        return;
      }
      await load();
      if (currentTable(target) === false) return;
      onaltered?.();
    } catch (e) {
      if (currentTable(target)) toast.error(errorMessage(e));
      throw e;
    }
  }

  function openColumn(column: ColumnInfo | null) {
    editing = column;
    columnOpen = true;
  }
</script>

{#if error}<div class="px-6 pt-6">
    <LoadError message={error} onretry={load} busy={loading} />
  </div>{/if}
{#if !structure && loading}
  <div class="mx-auto grid max-w-5xl gap-6 p-6 lg:p-8">
    <Skeleton class="h-72 rounded-3xl" /><Skeleton class="h-36 rounded-3xl" />
  </div>
{/if}
{#if !(!structure && loading) && structure}
  <div class="mx-auto grid max-w-5xl gap-4 p-4 *:min-w-0 sm:p-6 lg:p-8">
    <StructureColumns
      {structure}
      onadd={() => openColumn(null)}
      onedit={openColumn}
      ondelete={(column) => {
        toDelete = column;
        deleteOpen = true;
      }}
    />
    <TableSettings {structure} {policies} onalter={alter} ondrop={() => (dropOpen = true)} />
  </div>

  <ColumnSheet bind:open={columnOpen} table={name} original={editing} onsaved={load} />
  <DropTableDialog bind:open={dropOpen} table={name} {ondropped} />
  {#if toDelete}
    <ConfirmDialog
      bind:open={deleteOpen}
      title={t("tables.structure.deleteColumnTitle", { name: toDelete.name })}
      description={t("tables.structure.deleteColumnDescription")}
      confirmLabel={t("tables.structure.deleteColumn")}
      destructive
      onconfirm={() => alter([{ action: "drop_column", name: toDelete!.name }])}
    />
  {/if}
{/if}
