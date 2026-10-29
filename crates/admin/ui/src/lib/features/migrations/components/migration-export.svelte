<script lang="ts">
  import { untrack } from "svelte";
  import { FilePlus, LoaderCircle } from "@lucide/svelte";
  import { Dialog, Button, Input, Field } from "$lib/components/ui";
  import { UnsavedChangesDialog } from "$lib/components/shared";
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import { toast } from "svelte-sonner";
  import { downloadText } from "$lib/browser/download";
  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import type { MigrationCatalog, ExportedMigration } from "../catalog.svelte";
  let {
    resource,
    pendingCount,
    nextVersion,
    ongenerated,
  }: {
    resource: MigrationCatalog;
    pendingCount: number;
    nextVersion: number | undefined;
    ongenerated: (result: ExportedMigration) => void;
  } = $props();
  // The generate-migration dialog defaults to a name in the panel language.
  let dialogOpen = $state(false);
  let name = $state(t("migrations.dialog.defaultName"));
  let saving = $state(false);
  let initialName = $state("");
  const guard = new CloseGuard({
    dirty: () => name !== initialName,
    busy: () => saving,
    close: () => (dialogOpen = false),
    active: () => dialogOpen,
  });
  $effect(() => {
    if (dialogOpen) untrack(() => (initialName = name));
  });

  const MIGRATION_NAME = /^[a-z0-9][a-z0-9_]{0,59}$/;
  const validName = $derived(MIGRATION_NAME.test(name));

  async function generate(event: SubmitEvent) {
    event.preventDefault();
    if (validName === false || saving) return;
    saving = true;
    try {
      const result = await resource.generate(name);
      downloadText(result.filename, result.sql, "application/sql");
      ongenerated(result);
      dialogOpen = false;
      toast.success(t("migrations.generatedToast", { filename: result.filename }));
      await resource.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      saving = false;
    }
  }
</script>

{#if pendingCount > 0}<Button onclick={() => (dialogOpen = true)}
    ><FilePlus data-icon="inline-start" aria-hidden="true" />{t("migrations.generate")}</Button
  >{/if}
<Dialog.Root bind:open={() => dialogOpen, guard.change}>
  <Dialog.Content class="sm:max-w-md">
    <form class="grid gap-5" onsubmit={generate}>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        <Dialog.Header>
          <Dialog.Title>{t("migrations.generate")}</Dialog.Title>
          <Dialog.Description
            >{t("migrations.dialog.description", { count: pendingCount })}</Dialog.Description
          >
        </Dialog.Header>
        <Field.Group>
          <Field.Field data-invalid={validName === false}>
            <Field.Label for="migration-name">{t("common.name")}</Field.Label>
            <Input
              id="migration-name"
              name="migration-name"
              bind:value={name}
              maxlength={60}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={validName === false}
              aria-describedby="migration-name-hint"
            />
            {#if validName}
              <Field.Description id="migration-name-hint"
                >{t("migrations.dialog.file")}
                <span class="font-mono">V{nextVersion}__{name}.sql</span></Field.Description
              >
            {/if}
            {#if validName === false}
              <Field.Error id="migration-name-hint">{t("migrations.dialog.nameRule")}</Field.Error>
            {/if}
          </Field.Field>
        </Field.Group>
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={guard.request}
            >{t("common.cancel")}</Button
          >
          <Button type="submit" disabled={validName === false || saving}>
            {#if saving}<LoaderCircle
                data-icon="inline-start"
                class="animate-spin"
                aria-hidden="true"
              />{/if}
            {#if saving === false}<FilePlus data-icon="inline-start" aria-hidden="true" />{/if}
            {saving ? t("migrations.dialog.generating") : t("migrations.dialog.submit")}
          </Button>
        </Dialog.Footer>
      </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
