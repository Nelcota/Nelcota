<script lang="ts">
  import { requiredValue } from "$lib/contracts/required-value";
  import { tick, untrack } from "svelte";
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import { UnsavedChangesDialog, WizardProgress } from "$lib/components/shared";

  import { Save, LoaderCircle, Plus, X } from "@lucide/svelte";

  import { Sheet, Select, Field, Alert, Button, Input, Checkbox } from "$lib/components/ui";

  import { toast } from "svelte-sonner";
  import ColumnFields from "../columns/column-fields.svelte";

  import {
    blankColumn,
    ddl,
    type ColumnDef,
    initialTable,
    tableAccess,
    columnProblem,
    nameProblem,
    automaticColumn,
    SIMPLE_TYPES,
    type SimpleType,
    type Audience,
    type AccessLevel,
    loadSchemaColumns,
    loadTypes,
    SqlPreviewModel as Preview,
    GrantsEditor,
    AccessChoices,
    SqlPreview,
  } from "$lib/shared/schema";

  import { errorMessage, t } from "$lib/i18n/index.svelte";
  const REVIEW_STEP = 3;
  const INITIAL_FIELD_COUNT = 3;

  let {
    open = $bindable(false),
    oncreated,
  }: { open?: boolean; oncreated: (name: string) => void } = $props();
  let spec = $state(initialTable());
  let step = $state(0);
  let template = $state("blank");
  let advanced = $state(false);
  let audience = $state<Audience>("private");
  let level = $state<AccessLevel>("read");
  let keys = $state([0, 1, 2]);
  let nextKey = 3;
  let tables = $state<Record<string, string[]>>({});
  let saving = $state(false);
  let attempted = $state(false);
  let failure = $state("");
  let heading = $state<HTMLHeadingElement | null>(null);
  let initialValue = $state("");
  const draft = $derived(JSON.stringify({ spec, audience, level, advanced }));
  const guard = new CloseGuard({
    dirty: () => draft !== initialValue,
    busy: () => saving,
    close: () => (open = false),
    active: () => open,
  });
  const preview = new Preview();
  const steps = $derived(
    ["name", "fields", "access", "review"].map((key) =>
      t(`guided.table.steps.${key as "name" | "fields" | "access" | "review"}`),
    ),
  );
  const nameError = $derived(
    nameProblem(spec.name) ?? (Object.hasOwn(tables, spec.name.trim()) ? "exists" : null),
  );
  const columnsReady = $derived(
    spec.columns.length > 0 &&
      spec.columns.every(
        (column, index) =>
          Boolean(columnProblem(spec.columns, index)) === false && Boolean(column.data_type.trim()),
      ),
  );
  const ownerConflict = $derived(
    advanced === false &&
      audience === "owner" &&
      spec.columns.some(
        (column) => column.name.trim() === "user_id" && column.data_type !== "uuid",
      ),
  );
  const payload = $derived.by(() => {
    if (advanced)
      return {
        table: {
          ...spec,
          name: spec.name.trim(),
          columns: spec.columns.map((column) => ({ ...column, name: column.name.trim() })),
        },
        policies: [],
      };
    return ownerConflict ? null : tableAccess($state.snapshot(spec), audience, level);
  });
  const ready = $derived(Boolean(nameError) === false && columnsReady && payload !== null);
  const summary = $derived(
    t(`guided.access.summary.${audience}`, { actions: t(`guided.access.actions.${level}`) }),
  );

  $effect(() => {
    if (open === false) return;
    untrack(() => {
      spec = initialTable();
      step = 0;
      template = "blank";
      audience = "private";
      level = "read";
      advanced = false;
      keys = [0, 1, 2];
      nextKey = INITIAL_FIELD_COUNT;
      attempted = false;
      failure = "";
      tables = {};
      initialValue = JSON.stringify({ spec, audience, level, advanced });
      void loadTypes();
      loadSchemaColumns()
        .then((value) => {
          if (open) tables = value;
        })
        .catch(() => {});
    });
    return () => preview.clear();
  });
  $effect(() => {
    if (open === false || step !== REVIEW_STEP || Boolean(ready) === false || payload === null)
      return preview.clear();
    const snapshot = $state.snapshot(payload);
    preview.schedule((signal) =>
      ddl.createTable(snapshot.table, true, { signal, policies: snapshot.policies }),
    );
  });
  function applyTemplate(value: string) {
    template = value;
    const field = (name: string, data_type = "text", nullable = true): ColumnDef => ({
      ...blankColumn(),
      name,
      data_type,
      nullable,
    });
    const examples: Record<string, ColumnDef[]> = {
      blank: [blankColumn()],
      notes: [field("titulo", "text", false), field("conteudo")],
      tasks: [
        field("titulo", "text", false),
        { ...field("concluida", "boolean", false), default: "false" },
        field("prazo", "date"),
      ],
      products: [
        field("nome", "text", false),
        field("preco", "numeric", false),
        field("descricao"),
      ],
    };
    spec.columns = [
      ...initialTable().columns.slice(0, 2),
      ...(examples[value] ?? examples.blank ?? []),
    ];
    keys = spec.columns.map(() => nextKey++);
    attempted = false;
  }
  async function changeStep(value: number) {
    step = value;
    attempted = false;
    failure = "";
    await tick();
    heading?.focus();
  }
  function invalidStep(): boolean {
    return (
      (step === 0 && nameError != null) ||
      (step === 1 && Boolean(columnsReady) === false) ||
      (step === 2 && ownerConflict)
    );
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    attempted = true;
    if (invalidStep()) {
      await tick();
      document.querySelector<HTMLInputElement>('#create-table [aria-invalid="true"]')?.focus();
      return;
    }
    if (step < REVIEW_STEP) return await changeStep(step + 1);
    if (Boolean(ready) === false || payload === null) return;
    saving = true;
    failure = "";
    try {
      const snapshot = $state.snapshot(payload);
      await ddl.createTable(snapshot.table, false, { policies: snapshot.policies });
      toast.success(t("tables.toast.tableCreated"));
      open = false;
      oncreated(snapshot.table.name);
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      saving = false;
    }
  }
</script>

<Sheet.Root bind:open={() => open, guard.change}>
  <Sheet.Content class="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl">
    <Sheet.Header class="shrink-0 border-b px-6 py-5">
      <Sheet.Title>{t("tables.create.title")}</Sheet.Title>
      <Sheet.Description>{t("guided.table.description")}</Sheet.Description>
    </Sheet.Header>
    <WizardProgress {step} {steps} />
    <form
      id="create-table"
      class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6"
      onsubmit={submit}
      novalidate
    >
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        <div class="flex flex-col gap-1.5">
          <h3 bind:this={heading} tabindex="-1" class="text-lg font-semibold outline-none">
            {step === 0
              ? t("guided.table.startTitle")
              : step === 1
                ? t("guided.table.fieldsTitle")
                : step === 2
                  ? t("guided.table.accessTitle")
                  : t("guided.review")}
          </h3>
          <p class="text-sm text-muted-foreground">
            {step === 0
              ? t("guided.table.startHint")
              : step === 1
                ? t("guided.table.fieldsHint")
                : step === 2
                  ? t("guided.table.accessHint")
                  : t("guided.table.reviewHint")}
          </p>
        </div>
        {#if step === 0}
          <Field.Group>
            <Field.Field data-invalid={attempted && !!nameError}>
              <Field.Label for="table-name">{t("guided.table.name")}</Field.Label>
              <Input
                id="table-name"
                bind:value={spec.name}
                placeholder={t("tables.create.namePlaceholder")}
                autocomplete="off"
                spellcheck={false}
                aria-invalid={attempted && !!nameError}
                aria-describedby="table-name-hint"
              />
              <Field.Description id="table-name-hint"
                >{t("guided.table.nameHint")}</Field.Description
              >
              {#if attempted && nameError}<Field.Error
                  >{t(`guided.problems.${nameError}`)}</Field.Error
                >{/if}
            </Field.Field>
            <Field.Field>
              <Field.Label for="table-template">{t("guided.table.template")}</Field.Label>
              <Select.Root type="single" value={template} onValueChange={applyTemplate}>
                <Select.Trigger id="table-template" class="w-full"
                  >{t(
                    `guided.table.templates.${template as "blank" | "notes" | "tasks" | "products"}`,
                  )}</Select.Trigger
                >
                <Select.Content
                  ><Select.Group
                    >{#each ["blank", "notes", "tasks", "products"] as option}<Select.Item
                        value={option}
                        >{t(
                          `guided.table.templates.${option as "blank" | "notes" | "tasks" | "products"}`,
                        )}</Select.Item
                      >{/each}</Select.Group
                  ></Select.Content
                >
              </Select.Root>
              <Field.Description>{t("guided.table.templateHint")}</Field.Description>
            </Field.Field>
            <Field.Field
              ><Field.Label for="table-comment"
                >{t("tables.create.comment")}
                <span class="font-normal text-muted-foreground"
                  >({t("tables.create.optional")})</span
                ></Field.Label
              ><Input
                id="table-comment"
                bind:value={() => spec.comment ?? "", (value) => (spec.comment = value || null)}
              /></Field.Field
            >
          </Field.Group>
        {/if}
        {#if !(step === 0) && step === 1}
          <Field.Group
            ><Field.Field orientation="horizontal"
              ><Checkbox id="table-advanced" bind:checked={advanced} /><Field.Label
                for="table-advanced">{t("guided.technical")}</Field.Label
              ></Field.Field
            ></Field.Group
          >
          {#if !advanced}<p class="text-sm text-muted-foreground">
              {t("guided.table.automatic")}
            </p>{/if}
          <Field.Group class="gap-4">
            {#each spec.columns as column, index (keys[index])}
              {@const problem = columnProblem(spec.columns, index)}
              {@const fieldNumber = spec.columns
                .slice(0, index + 1)
                .filter((column) => !automaticColumn(column)).length}
              {#if advanced}
                <ColumnFields
                  bind:column={
                    () => requiredValue(spec.columns[index], "column definition"),
                    (value) => {
                      spec.columns[index] = value;
                    }
                  }
                  {tables}
                  mode="create"
                  onremove={spec.columns.length > 1
                    ? () => {
                        spec.columns.splice(index, 1);
                        keys.splice(index, 1);
                      }
                    : undefined}
                />
                {#if attempted && problem}<Field.Error
                    >{column.name || index + 1}: {t(`guided.problems.${problem}`)}</Field.Error
                  >{/if}
              {/if}
              {#if !advanced && !automaticColumn(column)}
                <Field.Set class="rounded-xl border p-4">
                  <div class="flex items-center justify-between gap-2">
                    <Field.Legend class="mb-0"
                      >{t("guided.table.fieldTitle", { number: fieldNumber })}</Field.Legend
                    ><Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("guided.table.remove", { number: fieldNumber })}
                      onclick={() => {
                        spec.columns.splice(index, 1);
                        keys.splice(index, 1);
                      }}><X aria-hidden="true" /></Button
                    >
                  </div>
                  <Field.Group class="gap-4">
                    <Field.Field data-invalid={attempted && !!problem}
                      ><Field.Label for={`column-${keys[index]}`}
                        >{t("guided.table.fieldName")}</Field.Label
                      ><Input
                        id={`column-${keys[index]}`}
                        bind:value={column.name}
                        placeholder={t("guided.table.fieldPlaceholder")}
                        autocomplete="off"
                        spellcheck={false}
                        aria-invalid={attempted && !!problem}
                      />{#if attempted && problem}<Field.Error
                          >{t(`guided.problems.${problem}`)}</Field.Error
                        >{/if}</Field.Field
                    >
                    <Field.Field>
                      <Field.Label for={`type-${keys[index]}`}
                        >{t("guided.table.fieldType")}</Field.Label
                      >
                      <Select.Root
                        type="single"
                        value={column.data_type}
                        onValueChange={(value) => {
                          column.data_type = value;
                          column.default = null;
                          column.identity = false;
                        }}
                      >
                        <Select.Trigger id={`type-${keys[index]}`} class="w-full"
                          ><span class="truncate"
                            >{SIMPLE_TYPES.includes(column.data_type as SimpleType)
                              ? t(`guided.table.types.${column.data_type as SimpleType}`)
                              : column.data_type}</span
                          ></Select.Trigger
                        >
                        <Select.Content
                          ><Select.Group
                            >{#each SIMPLE_TYPES as type}<Select.Item value={type}
                                >{t(`guided.table.types.${type}`)}</Select.Item
                              >{/each}</Select.Group
                          ></Select.Content
                        >
                      </Select.Root>
                      {#if SIMPLE_TYPES.includes(column.data_type as SimpleType)}<Field.Description
                          >{t(
                            `guided.table.examples.${column.data_type as SimpleType}`,
                          )}</Field.Description
                        >{/if}
                    </Field.Field>
                    <Field.Field orientation="horizontal"
                      ><Checkbox
                        id={`required-${keys[index]}`}
                        checked={!column.nullable}
                        onCheckedChange={(value) => (column.nullable = value !== true)}
                      /><Field.Label for={`required-${keys[index]}`}
                        >{t("guided.table.required")}</Field.Label
                      ></Field.Field
                    >
                  </Field.Group>
                </Field.Set>
              {/if}
            {/each}
          </Field.Group>
          <Button
            variant="outline"
            class="self-start"
            onclick={() => {
              spec.columns.push(blankColumn());
              keys.push(nextKey++);
            }}><Plus data-icon="inline-start" aria-hidden="true" />{t("guided.table.add")}</Button
          >
        {/if}
        {#if !(step === 0) && !(step === 1) && step === 2}
          {#if advanced}
            <p class="text-sm text-muted-foreground">{t("guided.table.advancedHint")}</p>
            <Field.Group
              ><Field.Field orientation="horizontal"
                ><Checkbox id="table-rls" bind:checked={spec.rls} /><Field.Label for="table-rls"
                  >{t("tables.create.rls")}</Field.Label
                ></Field.Field
              ></Field.Group
            >
            {#if !spec.rls}<Alert.Root variant="destructive"
                ><Alert.Description>{t("tables.create.noRlsWarning")}</Alert.Description
                ></Alert.Root
              >{/if}
            <GrantsEditor bind:grants={spec.grants} />
          {/if}
          {#if !advanced}
            <AccessChoices bind:audience bind:level allowPrivate />
            {#if audience === "owner"}{#if ownerConflict}<Alert.Root variant="destructive"
                  ><Alert.Description>{t("guided.access.ownerConflict")}</Alert.Description
                  ></Alert.Root
                >{/if}{#if !ownerConflict}<p class="text-sm text-muted-foreground">
                  {t("guided.access.ownerAdded")}
                </p>{/if}{/if}
          {/if}
        {/if}
        {#if !(step === 0) && !(step === 1) && !(step === 2) && payload}
          <div class="flex flex-col gap-4 rounded-xl border p-4">
            <div class="flex flex-col gap-1">
              <h4 class="font-semibold [overflow-wrap:anywhere]">{payload.table.name}</h4>
              {#if spec.comment}<p class="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {spec.comment}
                </p>{/if}
            </div>
            <p class="text-xs text-muted-foreground">
              {t("guided.table.fieldsCount", { count: payload.table.columns.length })}
            </p>
            <dl class="flex flex-col gap-3">
              {#each payload.table.columns as column}<div
                  class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm"
                >
                  <dt class="font-medium [overflow-wrap:anywhere]">{column.name}</dt>
                  <dd class="text-muted-foreground">
                    {SIMPLE_TYPES.includes(column.data_type as SimpleType)
                      ? t(`guided.table.types.${column.data_type as SimpleType}`)
                      : column.data_type} · {column.identity || column.default
                      ? t("guided.table.automaticField")
                      : column.nullable
                        ? t("guided.table.optional")
                        : t("guided.table.requiredField")}
                  </dd>
                </div>{/each}
            </dl>
          </div>
          <Alert.Root
            ><Alert.Title>{t("guided.table.steps.access")}</Alert.Title><Alert.Description
              >{advanced ? t("guided.table.customAccess") : summary}</Alert.Description
            ></Alert.Root
          >
          {#if !advanced}<p class="text-sm text-muted-foreground">
              {t("guided.access.protected")}
            </p>{/if}
          <SqlPreview {preview} />
        {/if}
        {#if failure}<Field.Error role="alert">{failure}</Field.Error>{/if}
      </fieldset>
    </form>
    <Sheet.Footer
      class="grid shrink-0 grid-cols-2 items-center gap-2 border-t px-6 py-4 sm:flex sm:flex-row sm:justify-between"
    >
      <Button variant="ghost" disabled={saving} onclick={guard.request}>{t("common.cancel")}</Button
      >
      <div class="contents sm:flex sm:gap-2">
        {#if step > 0}<Button
            variant="outline"
            disabled={saving}
            onclick={() => changeStep(step - 1)}>{t("guided.back")}</Button
          >{/if}
        <Button
          class={step > 0 ? "max-sm:col-span-2" : undefined}
          type="submit"
          form="create-table"
          disabled={saving || (step === 3 && !ready)}
        >
          {#if saving}<LoaderCircle
              data-icon="inline-start"
              class="animate-spin"
              aria-hidden="true"
            />{/if}
          {#if !saving && step === 3}<Save data-icon="inline-start" aria-hidden="true" />{/if}
          {saving
            ? t("common.creating")
            : step === 3
              ? t("tables.create.submit")
              : t("guided.next")}
        </Button>
      </div>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
