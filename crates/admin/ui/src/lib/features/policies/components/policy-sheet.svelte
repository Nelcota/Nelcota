<script lang="ts">
  import { requiredValue } from "../../../contracts/required-value.js";
  import { tick, untrack } from "svelte";
  import { CloseGuard, UnsavedChangesDialog } from "$lib/forms";
  import {
    Save,
    ChevronDown,
    SquareTerminal,
    WandSparkles as Wand,
    LoaderCircle,
  } from "@lucide/svelte";

  import { Sheet, Select, Field, Alert, Button, Input, Checkbox } from "$lib/components/ui";

  import { toast } from "svelte-sonner";

  import {
    ddl,
    policyFields,
    type PolicyDef,
    type ColumnInfo,
    guidedPolicy,
    uniquePolicyName,
    nameProblem,
    type Audience,
    type AccessLevel,
    SqlPreviewModel as Preview,
    AccessPicker,
    PolicySqlFields,
    SqlPreview,
  } from "$lib/shared/schema";

  import { guessOwnerColumn } from "$lib/features/policies/owner-column";

  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import { href } from "$lib/navigation/router.svelte";

  let {
    open = $bindable(false),
    table,
    original = null,
    existingNames = [],
    onsaved,
  }: {
    open?: boolean;
    table: string;
    original?: PolicyDef | null;
    existingNames?: string[];
    onsaved: () => void;
  } = $props();
  const blank = (): PolicyDef => ({
    name: "",
    command: "select",
    roles: ["authenticated"],
    permissive: true,
    using: "",
    check: "",
  });
  let custom = $state<PolicyDef>(blank());
  let advanced = $state(false);
  let prepareAccess = $state(false);
  let audience = $state<Audience>("owner");
  let level = $state<AccessLevel>("read");
  let ownerColumn = $state("");
  let initialOwner = $state("");
  let createOwner = $state(false);
  let initialCreateOwner = $state(false);
  let columns = $state<ColumnInfo[]>([]);
  let loading = $state(false);
  let loadError = $state("");
  let rlsEnabled = $state(true);
  let request: AbortController | undefined;
  let name = $state("");
  let nameEdited = $state(false);
  let saving = $state(false);
  // Nome e SQL ficam recolhidos; abrem sozinhos quando o nome tem um problema.
  let detailsOpen = $state(false);
  let attempted = $state(false);
  let failure = $state("");
  let initialValue = $state("");
  const draft = $derived(
    JSON.stringify({
      custom,
      advanced,
      prepareAccess,
      audience,
      level,
      name: nameEdited ? name : "",
      ownerColumn: ownerColumn === initialOwner ? "" : ownerColumn,
      createOwner: createOwner !== initialCreateOwner,
    }),
  );
  const guard = new CloseGuard({
    dirty: () => draft !== initialValue,
    busy: () => saving,
    close: () => (open = false),
    active: () => open,
  });
  const preview = new Preview();
  const ownerColumns = $derived(
    columns.filter(
      (column) =>
        column.data_type === "uuid" &&
        (Boolean(column.primary_key) === false || Boolean(column.default) === false),
    ),
  );
  const hasUserIdColumn = $derived(columns.some((column) => column.name === "user_id"));
  const addOwner = $derived(
    advanced === false &&
      audience === "owner" &&
      ownerColumns.length === 0 &&
      createOwner &&
      columns.some((column) => column.name === "user_id") === false,
  );
  const selectedOwner = $derived(addOwner ? "user_id" : ownerColumn);
  const ownerValid = $derived(
    audience !== "owner" || addOwner || ownerColumns.some((column) => column.name === ownerColumn),
  );
  const generated = $derived(
    requiredValue(
      guidedPolicy(audience, level, { column: selectedOwner }),
      "required operation value",
    ),
  );
  const suggestedName = $derived(uniquePolicyName(generated.name, existingNames));
  const fields = $derived(policyFields(custom.command));
  function policySql(value: string | null | undefined, enabled: boolean): string | null {
    const sql = value?.trim() ?? "";
    return enabled && sql !== "" ? sql : null;
  }
  const payload = $derived.by((): PolicyDef => {
    if (advanced === false) return { ...generated, name: nameEdited ? name.trim() : suggestedName };
    return {
      ...custom,
      name: custom.name.trim(),
      using: policySql(custom.using, fields.using),
      check: policySql(custom.check, fields.check),
    };
  });
  const nameError = $derived(
    nameProblem(payload.name) ??
      (payload.name !== original?.name && existingNames.includes(payload.name)
        ? "duplicate"
        : null),
  );
  const ready = $derived.by(() => {
    if (nameError !== null) return false;
    if (advanced) return Boolean(payload.command === "insert" ? payload.check : payload.using);
    return loading === false && loadError === "" && ownerValid;
  });
  const summary = $derived(
    t(`guided.access.summary.${audience}`, { actions: t(`guided.access.actions.${level}`) }),
  );

  function preferredOwner(candidates: readonly ColumnInfo[]): string {
    const guessed = guessOwnerColumn(candidates);
    return candidates.find((column) => column.name === guessed)?.name ?? candidates[0]?.name ?? "";
  }
  async function loadColumns() {
    request?.abort();
    const controller = (request = new AbortController());
    loading = true;
    loadError = "";
    try {
      const structure = await ddl.structure(table, { signal: controller.signal });
      if (controller.signal.aborted) return;
      columns = structure.columns;
      rlsEnabled = structure.rls_enabled;
      const candidates = structure.columns.filter(
        (column) =>
          column.data_type === "uuid" &&
          (Boolean(column.primary_key) === false || Boolean(column.default) === false),
      );
      ownerColumn = preferredOwner(candidates);
      initialOwner = ownerColumn;
      createOwner =
        Boolean(candidates.length) === false &&
        Boolean(structure.columns.some((column) => column.name === "user_id")) === false;
      initialCreateOwner = createOwner;
    } catch (error) {
      if (controller.signal.aborted === false) loadError = errorMessage(error);
    } finally {
      if (controller.signal.aborted === false) loading = false;
    }
  }
  $effect(() => {
    if (open === false) return;
    untrack(() => {
      custom = original != null ? { ...original, roles: [...original.roles] } : blank();
      advanced = Boolean(original);
      prepareAccess = false;
      audience = "owner";
      level = "read";
      ownerColumn = "";
      initialOwner = "";
      columns = [];
      createOwner = false;
      initialCreateOwner = false;
      name = "";
      nameEdited = false;
      saving = false;
      detailsOpen = false;
      attempted = false;
      failure = "";
      loadError = "";
      initialValue = JSON.stringify({
        custom,
        advanced,
        prepareAccess,
        audience,
        level,
        name: "",
        ownerColumn: "",
        createOwner: false,
      });
      void loadColumns();
    });
    return () => {
      request?.abort();
      preview.clear();
    };
  });
  $effect(() => {
    if (open === false || ready === false) return preview.clear();
    const snapshot = $state.snapshot(payload);
    const prepare = advanced === false || prepareAccess;
    const ownerField = addOwner ? "user_id" : undefined;
    preview.schedule((signal) =>
      original != null
        ? ddl.replacePolicy(table, original.name, {
            policy: snapshot,
            preview: true,
            options: {
              signal,
              prepareAccess: prepare,
            },
          })
        : ddl.createPolicy(table, snapshot, {
            preview: true,
            options: {
              signal,
              prepareAccess: prepare,
              ownerColumn: ownerField,
            },
          }),
    );
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    attempted = true;
    if (ready === false) {
      if (nameError !== null) detailsOpen = true;
      await tick();
      document.querySelector<HTMLInputElement>('#policy-form [aria-invalid="true"]')?.focus();
      return;
    }
    saving = true;
    failure = "";
    try {
      const snapshot = $state.snapshot(payload);
      const options = {
        prepareAccess: advanced === false || prepareAccess,
        ownerColumn: addOwner ? "user_id" : undefined,
      };
      if (original != null) {
        await ddl.replacePolicy(table, original.name, {
          policy: snapshot,
          preview: false,
          options: options,
        });
        toast.success(t("policies.sheet.saved", { name: snapshot.name }));
        open = false;
        onsaved();
        return;
      }
      await ddl.createPolicy(table, snapshot, { preview: false, options: options });
      toast.success(t("policies.sheet.saved", { name: snapshot.name }));
      open = false;
      onsaved();
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
      <Sheet.Title>{original ? t("policies.sheet.edit") : t("guided.policy.submit")}</Sheet.Title>
      <Sheet.Description
        >{t("policies.sheet.onTable")}
        <span class="font-medium text-foreground [overflow-wrap:anywhere]">{table}</span>. {t(
          "guided.policy.description",
        )}</Sheet.Description
      >
    </Sheet.Header>
    <form
      id="policy-form"
      class="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-6"
      onsubmit={submit}
      novalidate
    >
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        {#if loadError}<Alert.Root variant="destructive"
            ><Alert.Description>{loadError}</Alert.Description><Button
              variant="outline"
              size="sm"
              onclick={loadColumns}>{t("guided.policy.retry")}</Button
            ></Alert.Root
          >{/if}
        {#if advanced}
          <p class="text-sm text-muted-foreground">{t("guided.policy.advancedHint")}</p>
          <Field.Group
            ><Field.Field data-invalid={attempted && nameError !== null}
              ><Field.Label for="policy-name">{t("guided.policy.name")}</Field.Label><Input
                id="policy-name"
                bind:value={custom.name}
                aria-invalid={attempted && nameError !== null}
              />{#if attempted && nameError}<Field.Error
                  >{nameError === "duplicate"
                    ? t("guided.policy.duplicate")
                    : t(`guided.problems.${nameError}`)}</Field.Error
                >{/if}</Field.Field
            ></Field.Group
          >
          <PolicySqlFields bind:policy={custom} {ownerColumn} />
          <Field.Group
            ><Field.Field orientation="horizontal"
              ><Checkbox id="policy-prepare" bind:checked={prepareAccess} /><Field.Content
                ><Field.Label for="policy-prepare">{t("guided.policy.activate")}</Field.Label
                ><Field.Description>{t("guided.policy.activateHint")}</Field.Description
                ></Field.Content
              ></Field.Field
            ></Field.Group
          >
          {#if rlsEnabled === false && prepareAccess === false}<Alert.Root
              ><Alert.Description>{t("guided.policy.inactive")}</Alert.Description></Alert.Root
            >{/if}
          <SqlPreview {preview} />
        {/if}

        {#if advanced === false}
          <AccessPicker bind:audience bind:level />

          {#if audience === "owner"}
            <div class="grid gap-3">
              {#if loading}<p class="text-sm text-muted-foreground" role="status">
                  {t("guided.policy.loading")}
                </p>{/if}
              {#if loading === false && loadError === "" && ownerColumns.length > 0}
                <Field.Group
                  ><Field.Field
                    ><Field.Label for="policy-owner-column" class="text-base font-semibold"
                      >{t("guided.policy.ownerField")}</Field.Label
                    ><Select.Root type="single" bind:value={ownerColumn}
                      ><Select.Trigger id="policy-owner-column" class="w-full"
                        ><span class="truncate font-mono">{ownerColumn}</span></Select.Trigger
                      ><Select.Content
                        ><Select.Group
                          >{#each ownerColumns as column (column.name)}<Select.Item
                              value={column.name}
                              class="font-mono">{column.name}</Select.Item
                            >{/each}</Select.Group
                        ></Select.Content
                      ></Select.Root
                    ><Field.Description>{t("guided.policy.ownerHint")}</Field.Description
                    ></Field.Field
                  ></Field.Group
                >
              {/if}
              {#if loading === false && loadError === "" && ownerColumns.length === 0 && hasUserIdColumn === false}
                <Field.Group
                  ><Field.Field orientation="horizontal"
                    ><Checkbox id="policy-add-owner" bind:checked={createOwner} /><Field.Content
                      ><Field.Label for="policy-add-owner"
                        >{t("guided.policy.addOwner")}</Field.Label
                      ><Field.Description>{t("guided.policy.addOwnerHint")}</Field.Description
                      ></Field.Content
                    ></Field.Field
                  ></Field.Group
                >
              {/if}
              {#if loading === false && loadError === "" && ownerColumns.length === 0 && hasUserIdColumn}
                <Alert.Root
                  ><Alert.Description>{t("guided.policy.noOwner")}</Alert.Description></Alert.Root
                >
                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    href={href(`/tables/${encodeURIComponent(table)}/structure`)}
                    target="_blank"
                    rel="noopener">{t("guided.policy.structure")}</Button
                  ><Button variant="ghost" onclick={loadColumns}>{t("guided.policy.retry")}</Button>
                </div>
              {/if}
            </div>
          {/if}

          <!-- Describe each choice immediately instead of adding a separate review step. -->
          <section
            class="grid gap-2 rounded-2xl bg-well p-4"
            aria-live="polite"
            aria-labelledby="policy-result"
          >
            <h3 id="policy-result" class="text-sm font-medium text-muted-foreground">
              {t("guided.policy.result")}
            </h3>
            <p class="text-base font-medium">{summary}</p>
            {#if audience === "owner" && selectedOwner !== ""}<p
                class="text-sm text-muted-foreground"
              >
                {t("guided.policy.ownerSummary", { column: selectedOwner })}
              </p>{/if}
            {#if addOwner}<p class="text-sm text-warning">
                {t("guided.policy.newOwnerReview")}
              </p>{/if}
            <p class="text-sm text-muted-foreground">
              {t("guided.access.protected")}
              {t("guided.policy.reviewHint")}
            </p>
          </section>

          <details bind:open={detailsOpen} class="group rounded-2xl border">
            <summary
              class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-base font-medium [&::-webkit-details-marker]:hidden"
            >
              <ChevronDown
                class="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
                aria-hidden="true"
              />
              {t("guided.policy.details")}
              <span class="ml-auto truncate font-mono text-sm font-normal text-muted-foreground"
                >{payload.name}</span
              >
            </summary>
            <div class="grid gap-5 px-4 pb-4">
              <Field.Group
                ><Field.Field data-invalid={attempted && nameError !== null}
                  ><Field.Label for="policy-name">{t("guided.policy.name")}</Field.Label><Input
                    id="policy-name"
                    value={nameEdited ? name : suggestedName}
                    oninput={(event) => {
                      name = event.currentTarget.value;
                      nameEdited = true;
                    }}
                    aria-invalid={attempted && nameError !== null}
                  /><Field.Description>{t("guided.policy.nameHint")}</Field.Description
                  >{#if attempted && nameError}<Field.Error
                      >{nameError === "duplicate"
                        ? t("guided.policy.duplicate")
                        : t(`guided.problems.${nameError}`)}</Field.Error
                    >{/if}</Field.Field
                ></Field.Group
              >
              <SqlPreview {preview} />
            </div>
          </details>
        {/if}
        {#if failure}<Field.Error role="alert">{failure}</Field.Error>{/if}
      </fieldset>
    </form>
    <Sheet.Footer class="flex shrink-0 flex-row flex-wrap items-center gap-2 border-t px-6 py-4">
      {#if original == null}
        <Button
          variant="ghost"
          disabled={saving}
          onclick={() => {
            advanced = advanced === false;
            failure = "";
            attempted = false;
          }}
        >
          {#if advanced}<Wand data-icon="inline-start" aria-hidden="true" />{t(
              "guided.policy.guided",
            )}{/if}
          {#if advanced === false}<SquareTerminal data-icon="inline-start" aria-hidden="true" />{t(
              "guided.policy.advanced",
            )}{/if}
        </Button>
      {/if}
      <div class="ml-auto flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={saving} onclick={guard.request}
          >{t("common.cancel")}</Button
        >
        <Button
          type="submit"
          form="policy-form"
          disabled={saving ||
            (advanced === false && (loading || loadError !== "" || ownerValid === false))}
        >
          {#if saving}<LoaderCircle
              data-icon="inline-start"
              class="animate-spin"
              aria-hidden="true"
            />{/if}
          {#if saving === false}<Save data-icon="inline-start" aria-hidden="true" />{/if}
          {saving
            ? t("common.saving")
            : original
              ? t("policies.sheet.savePolicy")
              : t("guided.policy.submit")}
        </Button>
      </div>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
