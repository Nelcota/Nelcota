<script lang="ts">
  import { untrack } from "svelte";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Button } from "$lib/components/ui/button";
  import { X, ChevronDown } from "@lucide/svelte";

  import { ON_DELETE, type ColumnDef, type OnDelete } from "$lib/shared/schema/ddl";
  import { pgTypes } from "$lib/shared/schema/pg-types.svelte";
  import { SIMPLE_TYPES } from "$lib/shared/schema/guided-access";
  import { t } from "$lib/i18n/index.svelte";

  let {
    column = $bindable(),
    tables,
    mode,
    onremove,
  }: {
    column: ColumnDef;
    /** Tables and columns of the schema, for the foreign key. */
    tables: Record<string, string[]>;
    /** `create`: inside "New table"; `add`/`edit`: the Structure tab. */
    mode: "create" | "add" | "edit";
    onremove?: () => void;
  } = $props();

  const id = $props.id();
  // Many columns on screen (new table): one compact row each.
  const compact = $derived(mode === "create");
  // Starts collapsed only when creating a table (many columns on screen).
  let expanded = $state(untrack(() => mode !== "create"));

  // Name standard types; show the SQL field for custom types.
  const OTHER_TYPE = "__other__";
  const simpleType = $derived(
    SIMPLE_TYPES.find((type) => type === column.data_type.trim().toLowerCase()) ?? null,
  );
  // Expand advanced options when editing a column with a default, reference or other advanced setting.
  const advancedOpen = untrack(
    () =>
      mode === "edit" &&
      (column.default !== null ||
        column.unique ||
        column.identity ||
        column.references !== null ||
        column.comment !== null),
  );
  function chooseType(value: string) {
    if (value === OTHER_TYPE) {
      if (simpleType !== null) column.data_type = "";
      return;
    }
    column.data_type = value;
  }

  const INTEGER = new Set(["smallint", "integer", "bigint"]);
  const isInteger = $derived(INTEGER.has(column.data_type.trim().toLowerCase()));
  // When editing, PK and identity come from creation and do not change here.
  const structural = $derived(mode === "edit");

  /** DEFAULT suggestions by type. */
  const defaults = $derived.by(() => {
    const type = column.data_type.toLowerCase();
    if (type.startsWith("timestamp")) return ["now()"];
    if (type === "date") return ["current_date"];
    if (type === "uuid") return ["gen_random_uuid()"];
    if (type === "boolean") return ["false", "true"];
    if (type.startsWith("json")) return ["'{}'::jsonb", "'[]'::jsonb"];
    if (INTEGER.has(type) || type.startsWith("numeric")) return ["0"];
    return ["''"];
  });

  function setReference(table: string) {
    if (table === "") {
      column.references = null;
      return;
    }
    const columns = tables[table] ?? [];
    column.references = {
      table,
      column: columns.includes("id") ? "id" : (columns[0] ?? ""),
      on_delete: column.references?.on_delete ?? "no_action",
    };
  }

  const onDeleteLabel = (value: OnDelete) => {
    const key = ON_DELETE.find((o) => o.value === value)?.label;
    return key != null ? t(key) : value;
  };
</script>

<datalist id={`${id}-types`}>
  {#each pgTypes.base as type (type)}<option value={type}></option>{/each}
  {#each pgTypes.enums as type (type)}<option value={type}>enum</option>{/each}
</datalist>
<datalist id={`${id}-defaults`}>
  {#each defaults as value (value)}<option {value}></option>{/each}
</datalist>

{#snippet nameInput(cls: string)}
  <Input
    id={`${id}-name`}
    bind:value={column.name}
    placeholder={t("tables.columns.name")}
    class={cls}
    aria-label={compact ? t("tables.columns.nameLabel") : undefined}
    autocomplete="off"
    spellcheck={false}
  />
{/snippet}
{#snippet typeInput(cls: string)}
  <Input
    id={`${id}-type`}
    bind:value={column.data_type}
    list={`${id}-types`}
    placeholder={t("tables.columns.type")}
    class={cls}
    aria-label={compact ? t("tables.columns.typeLabel") : undefined}
    autocomplete="off"
    spellcheck={false}
  />
{/snippet}
{#snippet defaultInput(cls: string)}
  <Input
    id={`${id}-default`}
    bind:value={() => column.default ?? "", (v) => (column.default = v || null)}
    list={`${id}-defaults`}
    placeholder={column.identity ? "identity" : t("tables.columns.defaultPlaceholder")}
    disabled={column.identity}
    class={cls}
    aria-label={compact ? t("tables.columns.defaultLabel") : undefined}
    autocomplete="off"
    spellcheck={false}
  />
{/snippet}

{#snippet advancedFields()}
  <div
    class={[
      "grid gap-4 border-t p-4 text-[0.8125rem]",
      compact && "rounded-b-2xl bg-muted/30",
      !compact && "border-t-0 pt-0 sm:px-5",
    ]}
  >
    <div class="flex flex-wrap gap-4">
      <label class="flex items-center gap-1.5 text-muted-foreground">
        <Checkbox bind:checked={column.unique} disabled={column.primary_key} />{t(
          "tables.columns.unique",
        )}
      </label>
      {#if !structural}
        <label
          class={["flex items-center gap-1.5 text-muted-foreground", !isInteger && "opacity-50"]}
          title={t("tables.columns.identityOnlyIntegers")}
        >
          <Checkbox
            checked={column.identity}
            disabled={!isInteger}
            onCheckedChange={(v) => {
              column.identity = v === true;
              if (column.identity) column.default = null;
            }}
          />{t("tables.columns.identity")}
        </label>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span class="w-24 text-muted-foreground">{t("tables.columns.references")}</span>
      <Select.Root
        type="single"
        value={column.references?.table ?? ""}
        onValueChange={setReference}
      >
        <Select.Trigger
          aria-label={t("tables.columns.references")}
          size="sm"
          class="w-40 font-mono text-[0.8125rem]"
        >
          {column.references?.table ?? t("tables.columns.noTable")}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" class="text-[0.8125rem]">{t("tables.columns.noTable")}</Select.Item>
          {#each Object.keys(tables) as table (table)}
            <Select.Item value={table} class="font-mono text-[0.8125rem]">{table}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if column.references}
        <Select.Root type="single" bind:value={column.references.column}>
          <Select.Trigger
            aria-label={t("tables.columns.referenceColumn")}
            size="sm"
            class="w-32 font-mono text-[0.8125rem]">{column.references.column}</Select.Trigger
          >
          <Select.Content>
            {#each tables[column.references.table] ?? [] as name (name)}
              <Select.Item value={name} class="font-mono text-[0.8125rem]">{name}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-muted-foreground">{t("tables.columns.onDeleteLabel")}</span>
        <Select.Root type="single" bind:value={column.references.on_delete}>
          <Select.Trigger
            aria-label={t("tables.columns.onDeleteLabel")}
            size="sm"
            class="w-40 text-[0.8125rem]"
            >{onDeleteLabel(column.references.on_delete)}</Select.Trigger
          >
          <Select.Content>
            {#each ON_DELETE as option (option.value)}
              <Select.Item value={option.value} class="text-[0.8125rem]"
                >{t(option.label)}</Select.Item
              >
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <label for={`${id}-description`} class="w-24 text-muted-foreground"
        >{t("tables.columns.description")}</label
      >
      <Input
        id={`${id}-description`}
        bind:value={() => column.comment ?? "", (v) => (column.comment = v || null)}
        placeholder={t("tables.columns.descriptionPlaceholder")}
        class="flex-1 text-[0.8125rem]"
      />
    </div>
  </div>
{/snippet}

<div class="rounded-2xl bg-well">
  {#if !compact}
    <!-- Edit one column at a time using the table wizard terminology;
         keep SQL settings under advanced options. -->
    <div class="grid gap-5 p-4 sm:p-5">
      <div class="grid gap-1.5">
        <label for={`${id}-name`} class="text-sm font-medium">{t("guided.table.fieldName")}</label>
        {@render nameInput("")}
      </div>
      <div class="grid gap-1.5">
        <label for={`${id}-type-select`} class="text-sm font-medium"
          >{t("guided.table.fieldType")}</label
        >
        <Select.Root type="single" value={simpleType ?? OTHER_TYPE} onValueChange={chooseType}>
          <Select.Trigger id={`${id}-type-select`} class="w-full"
            ><span class="truncate"
              >{simpleType
                ? t(`guided.table.types.${simpleType}`)
                : t("tables.columns.typeOther")}</span
            ></Select.Trigger
          >
          <Select.Content
            ><Select.Group>
              {#each SIMPLE_TYPES as type (type)}<Select.Item value={type}
                  >{t(`guided.table.types.${type}`)}</Select.Item
                >{/each}
              <Select.Item value={OTHER_TYPE}>{t("tables.columns.typeOther")}</Select.Item>
            </Select.Group></Select.Content
          >
        </Select.Root>
        {#if simpleType}<p class="text-sm text-muted-foreground">
            {t(`guided.table.examples.${simpleType}`)}
          </p>{/if}
        {#if simpleType === null}{@render typeInput("font-mono text-[0.8125rem]")}{/if}
      </div>
      <label class="flex cursor-pointer items-center gap-2 text-sm font-medium" title="NOT NULL">
        <Checkbox
          checked={!column.nullable || column.primary_key}
          disabled={column.primary_key}
          onCheckedChange={(v) => (column.nullable = v !== true)}
        />{t("guided.table.required")}
      </label>
    </div>
    <details class="group border-t" open={advancedOpen}>
      <summary
        class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium sm:px-5 [&::-webkit-details-marker]:hidden"
      >
        <ChevronDown
          class="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
          aria-hidden="true"
        />{t("tables.columns.advanced")}
      </summary>
      <div class="grid gap-1.5 px-4 pb-4 sm:px-5">
        <label for={`${id}-default`} class="text-sm font-medium"
          >{t("tables.columns.defaultLabel")}
          <span class="font-normal text-muted-foreground">({t("tables.create.optional")})</span
          ></label
        >
        {@render defaultInput("font-mono text-[0.8125rem]")}
      </div>
      {@render advancedFields()}
    </details>
  {/if}
  {#if !!compact}
    <div class="flex flex-wrap items-center gap-2 p-3">
      {@render nameInput("w-32 font-mono text-[0.8125rem]")}
      {@render typeInput("w-32 font-mono text-[0.8125rem]")}
      {@render defaultInput("min-w-24 flex-1 font-mono text-[0.8125rem]")}

      {#if mode === "create"}
        <label
          class="flex cursor-pointer items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground"
          title={t("tables.columns.primaryKey")}
        >
          <Checkbox bind:checked={column.primary_key} />PK
        </label>
      {/if}
      <label
        class="flex cursor-pointer items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground"
        title="NOT NULL"
      >
        <Checkbox
          checked={!column.nullable || column.primary_key}
          disabled={column.primary_key}
          onCheckedChange={(v) => (column.nullable = v !== true)}
        />{t("tables.columns.required")}
      </label>

      <div class="ml-auto flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("tables.columns.more")}
          aria-expanded={expanded}
          onclick={() => (expanded = !expanded)}
        >
          <ChevronDown class={["transition-transform", expanded && "rotate-180"]} />
        </Button>
        {#if onremove}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("tables.columns.remove")}
            onclick={onremove}><X /></Button
          >
        {/if}
      </div>
    </div>
  {/if}

  {#if compact && expanded}
    {@render advancedFields()}
  {/if}
</div>
