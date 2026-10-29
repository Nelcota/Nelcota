<script lang="ts">
  import { onMount } from "svelte";
  import { MigrationUpload, MigrationExport } from "./components";
  import { Download, CircleCheck, FolderOpen, ChevronDown } from "@lucide/svelte";

  import { PageHeader, LoadError, CodeBlock } from "$lib/components/shared";

  import { Button, Skeleton } from "$lib/components/ui";

  import { MigrationCatalog, type ExportedMigration, type MigrationsData } from "./catalog.svelte";
  import {
    migrationStatus,
    needsAction,
    newestFirst,
    type Migration,
    type MigrationStatus,
  } from "$lib/features/migrations/timeline";
  import { errorMessage, hasMessage, i18n, intlLocale, t, translate } from "$lib/i18n/index.svelte";

  // One timeline: the next version starts with panel changes not exported yet;
  // existing migrations follow from newest to oldest.
  const resource = new MigrationCatalog();
  const data = $derived(resource.data);
  const error = $derived(resource.error == null ? "" : errorMessage(resource.error));
  const loading = $derived(resource.loading);

  async function load() {
    await resource.reload();
  }
  onMount(() => {
    void load();
    return () => resource.cancel();
  });

  const migrations = $derived(newestFirst(data?.migrations ?? []));
  const pendingCount = $derived(data?.pending.length ?? 0);
  const appliedCount = $derived(
    migrations.filter((migration) => migration.applied_on !== null).length,
  );

  let generated = $state<ExportedMigration | null>(null);

  const when = $derived(
    new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" }),
  );
  function date(value: string | null): string {
    if (value === null) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return when.format(parsed);
  }

  const generatedInFolder = $derived(
    generated !== null &&
      migrations.some(
        (migration) => migration.version === generated?.version && migration.in_folder === true,
      ),
  );
  const steps = $derived([
    {
      id: "generate",
      title: t("migrations.steps.generate"),
      hint: generated?.filename ?? t("migrations.steps.generateHint"),
      done: generated !== null,
    },
    {
      id: "keep",
      title: t("migrations.steps.keep"),
      hint: t("migrations.steps.keepHint"),
      done: false,
    },
    {
      id: "apply",
      title: t("migrations.steps.apply"),
      hint: t("migrations.steps.applyHint"),
      done: false,
    },
  ]);

  // Localize recorded change types; otherwise show the stored description.
  function describe(change: MigrationsData["pending"][number]): string {
    const key = `migrations.changes.${change.kind}`;
    if (change.kind == null || change.target === null || hasMessage(key) === false)
      return change.summary;
    return translate(i18n.locale, key, { name: change.target });
  }

  type MigrationDetail = { readonly text: string; readonly warn: boolean };
  function migrationDetails(migration: Migration, status: MigrationStatus): MigrationDetail[] {
    const details: MigrationDetail[] = [];
    if (status === "notApplied")
      details.push({ text: t("migrations.status.notApplied"), warn: true });
    if (migration.applied_on !== null)
      details.push({
        text: t("migrations.appliedOn", { date: date(migration.applied_on) }),
        warn: false,
      });
    if (status === "outsideFolder")
      details.push({ text: t("migrations.status.outsideFolder"), warn: true });
    if (migration.from_panel) details.push({ text: t("migrations.fromPanel"), warn: false });
    return details;
  }

  function statementsSql(statements: readonly string[]): string {
    return statements.map((statement) => statement.trim().replace(/;$/, "") + ";").join("\n");
  }
</script>

<div
  class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0"
>
  <PageHeader title={t("migrations.title")} description={t("migrations.description")}>
    {#snippet actions()}
      <MigrationExport
        {resource}
        {pendingCount}
        nextVersion={data?.next_version}
        ongenerated={(result) => {
          generated = result;
        }}
      />
    {/snippet}
  </PageHeader>

  <MigrationUpload {resource} onapplied={load} />

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if data == null && loading}
    <Skeleton class="h-5 w-72 max-w-full" />
    <Skeleton class="h-96 rounded-3xl" />
  {/if}

  {#if data}
    <p class="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-muted-foreground">
      <span class={[pendingCount > 0 && "font-medium text-warning"]}
        >{t("migrations.summary.pending", { count: pendingCount })}</span
      >
      <span aria-hidden="true">·</span>
      <span>{t("migrations.summary.applied", { count: appliedCount })}</span>
      <span aria-hidden="true">·</span>
      <span class="flex min-w-0 items-center gap-1.5">
        <FolderOpen class="size-4 shrink-0" aria-hidden="true" />
        {#if data.folder}<span
            >{t("migrations.folderRead")}
            <span class="font-mono [overflow-wrap:anywhere]">{data.folder}</span></span
          >{/if}
        {#if data.folder == null}<span>{t("migrations.folderMissing")}</span>{/if}
      </span>
    </p>

    {#if generated}
      <p class="flex items-start gap-3 rounded-2xl bg-brand/10 px-4 py-3 text-base">
        <CircleCheck class="mt-1 size-5 shrink-0 text-brand" aria-hidden="true" />
        <span>
          <span class="font-mono">{generated.filename}</span>
          {t("migrations.generatedBefore")}
          <span class="font-mono">migrations/</span>
          {t("migrations.generatedMiddle")}
          <span class="font-mono">nelcota migrate</span>
          {t("migrations.generatedAfter")}
        </span>
      </p>
    {/if}

    <section class="rounded-3xl bg-card p-5 sm:p-6" aria-labelledby="migrations-timeline">
      <h2 id="migrations-timeline" class="sr-only">{t("migrations.timeline")}</h2>
      <ol class="grid">
        <!-- Next version: panel changes that have not been exported yet. -->
        <li class="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4 pb-7">
          <span class="absolute top-7 bottom-0 left-[11px] w-px bg-border" aria-hidden="true"
          ></span>
          <span
            class={[
              "mt-0.5 size-6 rounded-full border-2 bg-card",
              pendingCount > 0 ? "border-warning" : "border-border-strong",
            ]}
            aria-hidden="true"
          ></span>
          <div class="grid min-w-0 gap-3">
            <div class="grid gap-0.5">
              <p class="text-lg font-semibold">
                <span class="font-mono">V{data.next_version}</span> · {t("migrations.next")}
              </p>
              {#if pendingCount > 0}<p class="text-base text-warning">
                  {t("migrations.nextPending", { count: pendingCount })}
                </p>{/if}
              {#if pendingCount === 0}
                <p class="text-base text-muted-foreground">
                  {t("migrations.nothingPending")}. {t("migrations.nothingPendingHint")}
                </p>
              {/if}
            </div>
            {#if pendingCount > 0}
              <ul class="grid gap-2">
                {#each data.pending as change (change.id)}
                  <li class="rounded-2xl bg-well px-4 py-3">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p class="text-base font-medium">{describe(change)}</p>
                      <p class="text-sm text-muted-foreground tabular-nums">
                        {date(change.applied_at)}
                      </p>
                    </div>
                    <details class="mt-1 text-base">
                      <summary class="cursor-pointer text-muted-foreground hover:text-foreground"
                        >{t("migrations.statements", { count: change.statements.length })}</summary
                      >
                      <div class="mt-2">
                        <CodeBlock code={statementsSql(change.statements)} lang="sql" />
                      </div>
                    </details>
                  </li>
                {/each}
              </ul>
            {/if}
            <!-- O passo a passo fica fechado; abre sozinho depois de gerar um arquivo. -->
            <details class="group rounded-2xl border" open={generated !== null}>
              <summary
                class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-base font-medium [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown
                  class="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
                  aria-hidden="true"
                />
                {t("migrations.steps.title")}
              </summary>
              <ol class="grid gap-4 px-4 pb-4" aria-label={t("migrations.steps.label")}>
                {#each steps as step, index (step.id)}
                  <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <span
                      class={[
                        "grid size-7 place-items-center rounded-full text-sm font-semibold tabular-nums",
                        step.done ? "bg-brand/15 text-brand" : "bg-well",
                      ]}
                    >
                      {#if step.done}<CircleCheck class="size-4" aria-hidden="true" />{/if}
                      {#if step.done === false}{index + 1}{/if}
                    </span>
                    <p class="self-center text-base font-medium">{step.title}</p>
                    <p
                      class={[
                        "col-start-2 text-base text-muted-foreground",
                        step.id === "generate" && generated && "break-all font-mono text-sm",
                      ]}
                    >
                      {step.hint}
                    </p>
                    {#if step.id === "keep" && generated}
                      <p
                        class={[
                          "col-start-2 text-sm",
                          generatedInFolder ? "text-success" : "text-warning",
                        ]}
                      >
                        {t(
                          generatedInFolder
                            ? "migrations.steps.inFolder"
                            : "migrations.steps.pending",
                        )}
                      </p>
                    {/if}
                  </li>
                {/each}
              </ol>
            </details>
          </div>
        </li>

        {#each migrations as migration, index (migration.version)}
          {@const status = migrationStatus(migration)}
          {@const warn = needsAction(status)}
          <li
            class={[
              "relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4",
              index < migrations.length - 1 && "pb-7",
            ]}
          >
            {#if index < migrations.length - 1}<span
                class="absolute top-7 bottom-0 left-[11px] w-px bg-border"
                aria-hidden="true"
              ></span>{/if}
            <span class="mt-0.5 grid size-6 place-items-center" aria-hidden="true">
              <span class={["size-3 rounded-full", warn ? "bg-warning" : "bg-success"]}></span>
            </span>
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div class="grid min-w-0 gap-1">
                <p class="font-mono text-base [overflow-wrap:anywhere]">
                  <span class="text-muted-foreground">V{migration.version}</span> · {migration.name}
                </p>
                <!-- The dot indicates status; text emphasizes only items requiring action. -->
                <p class="text-sm text-muted-foreground">
                  {#each migrationDetails(migration, status) as detail, detailIndex (detail.text)}
                    {#if detailIndex > 0}<span class="px-1.5" aria-hidden="true">·</span>{/if}
                    <span class={[detail.warn && "font-medium text-warning"]}>{detail.text}</span>
                  {/each}
                </p>
              </div>
              {#if migration.from_panel}
                <Button
                  variant="ghost"
                  size="sm"
                  href={`/admin/api/migrations/${migration.version}/file`}
                  download
                  ><Download data-icon="inline-start" aria-hidden="true" />{t(
                    "common.download",
                  )}</Button
                >
              {/if}
            </div>
          </li>
        {/each}

        {#if migrations.length === 0}
          <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4">
            <span
              class="mt-0.5 size-6 rounded-full border-2 border-dashed border-border-strong"
              aria-hidden="true"
            ></span>
            <div class="grid gap-0.5">
              <p class="text-base font-medium">{t("migrations.noMigrations")}</p>
              <p class="text-base text-muted-foreground">{t("migrations.noMigrationsHint")}</p>
            </div>
          </li>
        {/if}
      </ol>
    </section>
  {/if}
</div>
