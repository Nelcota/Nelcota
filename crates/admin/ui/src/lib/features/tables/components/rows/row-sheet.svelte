<script lang="ts">
  import { requiredValue, type Column, type RowData } from "$lib/contracts";
  import { tick, untrack } from "svelte";
  import { Sheet, Button } from "$lib/components/ui";

  import { toast } from "svelte-sonner";
  import RowField from "./row-field.svelte";
  import { CloseGuard, UnsavedChangesDialog } from "$lib/forms";
  import { Save, LoaderCircle } from "@lucide/svelte";

  import { api, enc } from "$lib/transport/api";
  import {
    fieldProblem,
    initialFields,
    rowPayload,
    type FieldState,
  } from "$lib/features/tables/rows/row-form";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  let {
    open = $bindable(false),
    table,
    columns,
    primaryKey,
    row = null,
    onsaved,
  }: {
    open?: boolean;
    table: string;
    columns: Column[];
    primaryKey: string[];
    /** `null` = insert a new row. */
    row?: RowData | null;
    onsaved: () => void;
  } = $props();

  let fields = $state<Record<string, FieldState>>({});
  let saving = $state(false);
  let initial = $state("");
  const guard = new CloseGuard({
    dirty: () => JSON.stringify(fields) !== initial,
    busy: () => saving,
    close: () => (open = false),
    active: () => open,
  });

  // Reload the fields whenever the sheet opens.
  $effect(() => {
    if (open)
      untrack(() => {
        fields = initialFields(columns, row);
        initial = JSON.stringify(fields);
        attempted = false;
      });
  });

  const inserting = $derived(row === null);
  const editable = $derived(columns.filter((c) => Boolean(c.generated) === false));
  const generated = $derived(columns.filter((c) => c.generated));
  const problems = $derived(
    Object.fromEntries(
      editable.map((c) => [
        c.name,
        fields[c.name] !== undefined
          ? fieldProblem(c, requiredValue(fields[c.name], "row field"), inserting)
          : null,
      ]),
    ),
  );
  const valid = $derived(Object.values(problems).every((p) => p === null));
  // An empty required field is not a mistake until the person tries to save:
  // flagging it on open painted the form red before anything was typed.
  let attempted = $state(false);
  const shown = (column: string) =>
    problems[column] === "required" && attempted === false ? null : (problems[column] ?? null);
  const payload = $derived(rowPayload(columns, fields, row));
  const changes = $derived(Object.keys(payload).length);
  /** `id = 1` (or the composite key) to tell which row is open. */
  const pkLabel = $derived(
    row != null
      ? primaryKey.map((k) => `${k} = ${requiredValue(row, "row")[k] ?? "NULL"}`).join(", ")
      : "",
  );

  async function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (saving) return;
    if (valid === false) {
      attempted = true;
      await tick();
      document.querySelector<HTMLElement>('#row-form [aria-invalid="true"]')?.focus();
      return;
    }
    if (row != null && changes === 0) {
      open = false;
      return;
    }
    saving = true;
    try {
      // This helper returns a fresh flat record of primitives. Svelte's
      // snapshot copies through assignment and drops an own __proto__ key.
      const values = rowPayload(columns, fields, row);
      if (row != null) {
        const res = await api.patch<{ count: number }>(`/tables/${enc(table)}/rows`, {
          pk: Object.fromEntries(primaryKey.map((k) => [k, requiredValue(row, "row")[k]])),
          values,
        });
        toast.success(t("tables.toast.rowsUpdated", { count: res.count }));
        open = false;
        onsaved();
        return;
      }
      await api.post(`/tables/${enc(table)}/rows`, { values });
      toast.success(t("tables.toast.rowInserted"));
      open = false;
      onsaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  }
</script>

<Sheet.Root bind:open={() => open, guard.change}>
  <Sheet.Content class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-xl">
    <Sheet.Header class="border-b px-6 pt-6 pb-5">
      <Sheet.Title
        >{inserting ? t("tables.row.insertTitle") : t("tables.row.editTitle")}</Sheet.Title
      >
      <Sheet.Description>
        {t("tables.row.in")}
        <code class="font-mono text-foreground">{table}</code>{#if pkLabel}<span
            class="text-muted-foreground">{` · `}</span
          ><code class="font-mono text-foreground">{pkLabel}</code>{/if}
      </Sheet.Description>
    </Sheet.Header>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form
      id="row-form"
      class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6"
      onsubmit={save}
      onkeydown={onKeydown}
    >
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        {#if generated.length}
          <div class="rounded-2xl bg-well px-4 py-3 text-[0.8125rem]">
            <p class="font-medium text-muted-foreground">{t("tables.row.generated")}</p>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {#each generated as column (column.name)}
                <dt class="font-mono text-muted-foreground">{column.name}</dt>
                <dd class="truncate font-mono">
                  {row ? (row[column.name] ?? "NULL") : t("tables.row.setOnSave")}
                </dd>
              {/each}
            </dl>
          </div>
        {/if}
        {#each editable as column (column.name)}
          {#if fields[column.name]}
            <RowField
              {column}
              bind:field={
                () => requiredValue(fields[column.name], "row field"),
                (value) => {
                  fields[column.name] = value;
                }
              }
              {inserting}
              problem={shown(column.name)}
            />
          {/if}
        {/each}
      </fieldset>
    </form>

    <Sheet.Footer class="flex-row items-center gap-2 border-t bg-muted/40 px-6 py-4">
      <span class="mr-auto text-xs text-muted-foreground">
        {#if !inserting}{changes === 0
            ? t("tables.row.noChanges")
            : t("tables.row.changed", { count: changes })}{/if}
        <span class="hidden sm:inline">{inserting ? "" : " · "}{t("tables.row.saveHint")}</span>
      </span>
      <Button variant="outline" disabled={saving} onclick={guard.request}
        >{t("common.cancel")}</Button
      >
      <Button type="submit" form="row-form" disabled={saving || (!inserting && changes === 0)}>
        {#if saving}<LoaderCircle
            data-icon="inline-start"
            class="animate-spin"
            aria-hidden="true"
          />{/if}
        {#if !saving}<Save data-icon="inline-start" aria-hidden="true" />{/if}
        {saving ? t("common.saving") : inserting ? t("tables.row.insert") : t("common.save")}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
