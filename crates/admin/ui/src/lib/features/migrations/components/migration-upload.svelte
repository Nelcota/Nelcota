<script lang="ts">
  import { onMount } from "svelte";
  import { Button, Table } from "$lib/components/ui";
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import type { MigrationApplication } from "$lib/contracts/types";
  import { href } from "$lib/navigation/router.svelte";
  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import { ApiError } from "$lib/transport/api-error";
  import type { MigrationCatalog } from "../catalog.svelte";
  let { resource, onapplied }: { resource: MigrationCatalog; onapplied: () => Promise<void> } =
    $props();
  let uploaded = $state<FileList>();
  let busy = $state(false);
  let applying = $state(false);
  let result = $state<MigrationApplication | null>(null);
  let failure = $state("");
  let backupHelp = $state(false);
  let alive = true;
  const isAlive = (): boolean => alive;
  const MAX_MIGRATION_FILES = 1024;
  const BYTES_PER_KIB = 1024;
  const MAX_MIGRATION_BYTES = 2 * BYTES_PER_KIB * BYTES_PER_KIB;
  let request: AbortController | null = null;
  // The texts the preview checked. Apply sends exactly these: reading the
  // files again could pick up an edit made on disk after the preview.
  let previewed: { filename: string; sql: string }[] | null = null;
  new CloseGuard({ dirty: () => false, busy: () => busy, active: () => busy, close: () => {} });
  const canApply = $derived(
    result?.report.dry_run === true &&
      result.report.migrations.some((migration) => migration.state === "pending") &&
      result.report.migrations.every(
        (migration) => migration.state === "pending" || migration.state === "applied",
      ),
  );
  const changed = () => {
    result = null;
    previewed = null;
    failure = "";
    backupHelp = false;
  };
  const canPreview = $derived(busy === false && uploaded !== undefined && uploaded.length > 0);
  function withinBudget(files: readonly File[]): boolean {
    return (
      files.length <= MAX_MIGRATION_FILES &&
      files.reduce((bytes, file) => bytes + file.size, 0) <= MAX_MIGRATION_BYTES
    );
  }
  function failed(cause: unknown, dryRun: boolean, submitted: boolean): void {
    if (isAlive() === false) return;
    failure = errorMessage(cause);
    if (submitted && dryRun === false) failure += ` ${t("migrations.result.uncertain")}`;
    backupHelp =
      cause instanceof ApiError &&
      ["migration_backup_required", "migration_backup_failed"].includes(cause.code ?? "");
  }
  const allowed = (dryRun: boolean): boolean => canPreview && (dryRun || canApply);
  async function applyFiles(dryRun: boolean) {
    if (allowed(dryRun) === false) return;
    const selected = Array.from(uploaded ?? []);
    if (withinBudget(selected) === false) {
      changed();
      failure = t("migrations.result.fileBudget");
      return;
    }
    const checked = previewed;
    busy = true;
    applying = dryRun === false;
    changed();
    const abort = new AbortController();
    request = abort;
    let submitted = false;
    try {
      const files =
        dryRun === false && checked !== null
          ? checked
          : await Promise.all(
              selected.map(async (file) => ({ filename: file.name, sql: await file.text() })),
            );
      if (isAlive() === false) return;
      if (
        new TextEncoder().encode(JSON.stringify({ files, dry_run: dryRun })).length >
        MAX_MIGRATION_BYTES
      )
        throw new Error(t("migrations.result.fileBudget"));
      submitted = true;
      const reply = await resource.apply(files, dryRun, abort.signal);
      if (isAlive() === false) return;
      result = reply;
      if (dryRun) previewed = files;
      await onapplied();
    } catch (cause) {
      failed(cause, dryRun, submitted);
    } finally {
      busy = false;
      if (request === abort) request = null;
    }
  }
  onMount(() => () => {
    alive = false;
    request?.abort();
  });
</script>

<section class="grid gap-3 rounded-3xl bg-card p-6" aria-busy={busy}>
  <h2 class="text-lg font-semibold">{t("migrations.upload.title")}</h2>
  <p class="text-sm text-muted-foreground">{t("migrations.upload.description")}</p>
  <label class="grid gap-2 text-sm"
    >{t("migrations.upload.files")}
    <input
      type="file"
      accept=".sql"
      multiple
      bind:files={uploaded}
      disabled={busy}
      onchange={changed}
    />
  </label>
  <p class="text-sm text-muted-foreground">{t("migrations.result.previewFirst")}</p>
  <div class="flex flex-wrap gap-2">
    <Button variant="outline" disabled={busy || !uploaded?.length} onclick={() => applyFiles(true)}
      >{t("migrations.upload.preview")}</Button
    >
    <Button disabled={busy || !canApply} onclick={() => applyFiles(false)}
      >{t("migrations.upload.apply")}</Button
    >
    <Button variant="ghost" href={href("/connect?section=api-deploy")}
      >{t("migrations.result.deployment")}</Button
    >
  </div>
  {#if busy}<p role="status">
      {t(applying ? "migrations.result.applying" : "migrations.result.working")}
    </p>{/if}
  {#if failure}<p role="alert" class="text-sm text-destructive">{failure}</p>{/if}
  {#if backupHelp}<a
      class="text-sm underline"
      href={href("/guides/remote-migrations?section=automatic-backup-before-application")}
      >{t("migrations.result.backupHelp")}</a
    >{/if}
  {#if result}
    <p role="status">
      {result.report.dry_run
        ? t("migrations.result.previewResult")
        : t("migrations.result.applyResult", { count: result.report.applied.length })}
    </p>
    {#if result.report.migrations.every((migration) => migration.state === "applied")}<p
        class="text-sm"
      >
        {t("migrations.result.noChanges")}
      </p>{/if}
    {#if result.catalog_pending}<p role="status" class="text-sm text-warning">
        {t("migrations.result.catalogPending")}
      </p>{/if}
    {#if result.report.backup}<p class="break-all text-sm" translate="no">
        {t("migrations.result.backup", { backup: result.report.backup })}
      </p>{/if}
    <div class="overflow-auto rounded-xl border">
      <Table.Root>
        <caption class="sr-only">{t("migrations.result.history")}</caption>
        <Table.Header
          ><Table.Row
            ><Table.Head>{t("migrations.result.version")}</Table.Head><Table.Head
              >{t("migrations.result.name")}</Table.Head
            ><Table.Head>{t("migrations.result.state")}</Table.Head></Table.Row
          ></Table.Header
        >
        <Table.Body
          >{#each result.report.migrations as migration (migration.version)}<Table.Row>
              <Table.Cell>V{migration.version}</Table.Cell><Table.Cell translate="no"
                >{migration.name}</Table.Cell
              ><Table.Cell>{t(`migrations.result.${migration.state}`)}</Table.Cell>
            </Table.Row>{/each}</Table.Body
        >
      </Table.Root>
    </div>
    {#if result.report.dry_run === false}<p class="text-sm">
        {t("migrations.result.afterApply")}
      </p>{/if}
  {/if}
</section>
