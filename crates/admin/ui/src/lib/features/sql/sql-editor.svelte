<script lang="ts">
  import {
    errorOffset,
    downloadSqlResult,
    runAs,
    runAsRequest,
    setRunAs,
    draftName,
    changesSchema,
    SqlExecution,
    sqlAdapter,
    SQL_SNIPPETS,
    sqlStore,
    type SavedQuery,
    type SqlDraft,
  } from "$lib/features/sql/model";
  import { onMount, onDestroy } from "svelte";
  import { Button, DropdownMenu, Resizable, type ResizablePane as Pane } from "$lib/components/ui";

  import {
    Play,
    Square,
    ChevronDown,
    FolderOpen,
    RotateCcwClock as History,
    Save,
    Download,
    Pencil,
    FileCode,
    LoaderCircle,
  } from "@lucide/svelte";

  import { toast } from "svelte-sonner";
  import {
    CodeEditor,
    type Cursor,
    QueryTitle,
    EditorStatus,
    SaveQueryDialog,
    SqlSidebar,
    ResultTable,
  } from "$lib/features/sql/components";
  import {
    RunAsPicker,
    EmptyState,
    ConfirmDialog,
    CellDetailDialog,
    type RunAsLabels,
    type Viewer,
  } from "$lib/components/shared";

  import { errorMessage, t } from "$lib/i18n/index.svelte";

  // The SQL editor's words for who a run acts as (D94).
  const runAsLabels: RunAsLabels = $derived({
    label: t("sql.runAs.label"),
    owner: t("sql.runAs.owner"),
    ownerHint: t("sql.runAs.ownerHint"),
    anon: t("sql.runAs.anon"),
    anonHint: t("sql.runAs.anonHint"),
    authenticated: t("sql.runAs.authenticated"),
    authenticatedHint: t("sql.runAs.authenticatedHint"),
    asVisitor: t("sql.runAs.asVisitor"),
    asUser: (email: string) => t("sql.runAs.asUser", { email }),
    ownerTrigger: t("sql.editor.ownerNote"),
    ownerTriggerMore: t("sql.editor.ownerNoteMore"),
    ownerTriggerTitle: t("sql.editor.ownerNoteTitle"),
    pickTitle: t("sql.runAs.pickTitle"),
    search: t("sql.runAs.search"),
    empty: t("sql.runAs.empty"),
    noUsers: t("sql.runAs.noUsers"),
    loading: t("sql.runAs.loading"),
  });

  function chooseRunAs(viewer: Viewer) {
    if (viewer.mode === "authenticated" && viewer.user != null) {
      setRunAs("authenticated", viewer.user);
      return;
    }
    setRunAs(viewer.mode === "anon" ? "anon" : "owner");
  }

  import type { SqlResult } from "$lib/contracts/types";
  const QUERY_PREVIEW_LENGTH = 70;

  const execution = new SqlExecution(sqlAdapter);
  const schema = $derived(execution.schema.data?.tables ?? {});
  const defaultSchema = $derived(execution.schema.data?.schema ?? "public");
  const running = $derived(execution.running);
  const response = $derived(
    Boolean(execution.error) === true
      ? {
          error: {
            message: errorMessage(execution.error),
            code: null,
            detail: null,
            hint: null,
            position: null,
          },
        }
      : execution.response,
  );
  const elapsed = $derived(execution.elapsed);
  let resultsRegion = $state<HTMLElement>();
  let resultsContent = $state<HTMLElement>();
  // Where each result table's rows start in the pane's content, by result
  // index: virtualized rows are positioned from there. Measured in one pass
  // whenever anything in the pane can have moved them.
  let rowOffsets = $state<Record<number, number>>({});
  let offsetsFrame = 0;
  function measureRowOffsets() {
    const region = resultsRegion;
    if (region === undefined) return;
    const contentTop = region.getBoundingClientRect().top - region.scrollTop;
    const next: Record<number, number> = {};
    for (const body of region.querySelectorAll<HTMLElement>("tbody[data-result-index]")) {
      next[Number(body.dataset.resultIndex)] = body.getBoundingClientRect().top - contentTop;
    }
    if (sameOffsets(next, rowOffsets) === false) rowOffsets = next;
  }
  function sameOffsets(next: Record<number, number>, current: Record<number, number>): boolean {
    const indexes = Object.keys(next).map(Number);
    if (indexes.length !== Object.keys(current).length) return false;
    return indexes.every((index) => {
      const previous = current[index];
      return previous !== undefined && Math.abs(previous - (next[index] ?? 0)) < 1;
    });
  }
  function scheduleRowOffsets() {
    cancelAnimationFrame(offsetsFrame);
    offsetsFrame = requestAnimationFrame(measureRowOffsets);
  }
  // Size changes: the pane (wrapping notes) and the tables (measured rows).
  $effect(() => {
    const region = resultsRegion;
    const content = resultsContent;
    if (region === undefined) return;
    const observer = new ResizeObserver(scheduleRowOffsets);
    observer.observe(region);
    if (content !== undefined) observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(offsetsFrame);
    };
  });
  // Moves without a resize: the progress bar and the notes above the tables.
  $effect(() => {
    void running;
    void response;
    scheduleRowOffsets();
  });
  onMount(() => {
    void execution.loadSchema();
  });
  onDestroy(() => execution.cancel());

  // Name dialog: save as a new query, or rename an existing one.
  let dialog = $state<{ mode: "save" | "rename"; query?: SavedQuery } | null>(null);
  let dialogOpen = $state(false);
  let toDelete = $state<SavedQuery | null>(null);
  let deleteOpen = $state(false);
  let toDeleteDraft = $state<SqlDraft | null>(null);
  let deleteDraftOpen = $state(false);
  let detail = $state<{ title: string; value: string | null } | null>(null);
  let detailOpen = $state(false);

  // Cursor and selection, for the status bar and to run only what is selected.
  let cursor = $state<Cursor>({ line: 1, column: 1, from: 0, to: 0 });
  const selection = $derived(
    cursor.from !== cursor.to ? sqlStore.draft.slice(cursor.from, cursor.to) : "",
  );
  const runsSelection = $derived(selection.trim() !== "");
  /** Where the last run failed, as an offset in the editor text. */
  let errorAt = $state<number | null>(null);
  // Before the first run the results pane stays short, its empty state showing
  // where results will appear; the first run gives it room unless resized.
  const PREVIEW_SIZE = 25;
  const RESULTS_SIZE = 58;
  let resultsPane = $state<Pane>();
  let previewing = true;
  $effect(() => {
    if (resultsPane == null || previewing === false) return;
    if (execution.response != null || Boolean(execution.error) || execution.running) return;
    resultsPane.resize(PREVIEW_SIZE);
  });

  async function run() {
    if (execution.running) return;
    const code = runsSelection ? selection : sqlStore.draft;
    const offset = runsSelection ? cursor.from : 0;
    errorAt = null;
    resultsPane?.expand();
    if (previewing && resultsPane != null && resultsPane.getSize() <= PREVIEW_SIZE)
      resultsPane.resize(RESULTS_SIZE);
    previewing = false;
    if (await execution.run(code, runAsRequest())) {
      sqlStore.remember(code);
      // New or changed tables and columns show up in autocomplete right away.
      if (changesSchema(code)) void execution.loadSchema();
    }
    errorAt = queryErrorOffset(code, offset);
  }
  function queryErrorOffset(code: string, offset: number): number | null {
    const result = execution.response;
    if (Boolean(execution.error) === true || result === null || "error" in result === false)
      return null;
    const position = result.error.position;
    if (position === null || position === 0 || Number.isNaN(position)) return null;
    const local = errorOffset(code, position);
    return local === null ? null : offset + local;
  }

  /** Stops waiting for the query; dropping the request cancels it on the server. */
  function stop() {
    if (Boolean(execution.running) === false) return;
    execution.stop();
    toast.info(t("sql.editor.stoppedToast"));
  }

  /** Line of the editor text where the last run failed. */
  const errorLine = $derived(
    errorAt === null ? null : sqlStore.draft.slice(0, errorAt).split("\n").length,
  );

  /** Saves the open query; with none open, asks for a name. */
  function save() {
    if (Boolean(sqlStore.draft.trim()) === false) return;
    const current = sqlStore.current;
    if (current != null) {
      sqlStore.save(current.name);
      toast.success(t("sql.editor.savedToast", { name: current.name }));
      return;
    }
    openDialog({ mode: "save" });
  }

  function openDialog(next: { mode: "save" | "rename"; query?: SavedQuery }) {
    dialog = next;
    dialogOpen = true;
  }

  function submitName(name: string) {
    if (dialog?.mode === "rename" && dialog.query != null) {
      sqlStore.rename(dialog.query.id, name);
      return;
    }
    sqlStore.save(name, true);
    toast.success(t("sql.editor.savedToast", { name }));
  }

  function askDelete(query: SavedQuery) {
    toDelete = query;
    deleteOpen = true;
  }

  function exportResult(result: SqlResult, index: number, format: "csv" | "json") {
    downloadSqlResult(result, {
      baseName: sqlStore.current?.name ?? t("sql.editor.exportBaseName"),
      index,
      format,
    });
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  }

  const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, QUERY_PREVIEW_LENGTH);

  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="mx-auto flex h-full min-h-0 w-full max-w-page flex-col gap-3 px-4 pt-4 pb-4 sm:px-6 lg:flex-row lg:px-8"
>
  <SqlSidebar
    onrename={(query) => openDialog({ mode: "rename", query })}
    ondelete={askDelete}
    ondeleteDraft={(draft) => {
      toDeleteDraft = draft;
      deleteDraftOpen = true;
    }}
  />

  <div class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl bg-card">
    <!-- Visual order differs by width. Phones: title with the open/history/save
         icons, then "run as" next to Run. Desktop: title, run as, history,
         save, run. -->
    <div
      class="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2.5 sm:gap-x-3 xl:flex-nowrap"
    >
      <div class="order-1 min-w-0 flex-1 basis-24 sm:basis-40">
        <QueryTitle
          name={sqlStore.current?.name ?? null}
          fallback={sqlStore.draft.trim() ? draftName(sqlStore.draft) : t("sql.editor.newQuery")}
          dirty={sqlStore.dirty}
          onrename={(name) => sqlStore.current && sqlStore.rename(sqlStore.current.id, name)}
          onsave={() => openDialog({ mode: "save" })}
        />
      </div>
      <div class="order-4 min-w-0 lg:order-2">
        <RunAsPicker viewer={runAs} labels={runAsLabels} warnOwner onchange={chooseRunAs} />
      </div>
      <div class="order-2 flex items-center gap-1 sm:ml-auto lg:order-3">
        <!-- On screens without the sidebar, templates and saved queries live in a menu. -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                variant="ghost"
                size="sm"
                class="lg:hidden"
                title={t("sql.editor.open")}
                {...props}
                ><FolderOpen data-icon="inline-start" aria-hidden="true" /><span
                  class="max-sm:sr-only">{t("sql.editor.open")}</span
                ></Button
              >
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-64">
            {#if sqlStore.saved.length}
              <DropdownMenu.Group>
                <DropdownMenu.Label class="text-xs text-muted-foreground"
                  >{t("sql.editor.saved")}</DropdownMenu.Label
                >
                {#each sqlStore.sorted as query (query.id)}
                  <DropdownMenu.Item onclick={() => sqlStore.openSaved(query.id)}
                    ><FileCode aria-hidden="true" />{query.name}</DropdownMenu.Item
                  >
                {/each}
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
            {/if}
            {#if sqlStore.looseDrafts.length}
              <DropdownMenu.Group>
                <DropdownMenu.Label class="text-xs text-muted-foreground"
                  >{t("sql.editor.drafts")}</DropdownMenu.Label
                >
                {#each sqlStore.looseDrafts as draft (draft.id)}
                  <DropdownMenu.Item onclick={() => sqlStore.openDraft(draft.id)}
                    ><FileCode aria-hidden="true" /><span class="truncate"
                      >{draftName(draft.sql)}</span
                    ></DropdownMenu.Item
                  >
                {/each}
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
            {/if}
            <DropdownMenu.Group>
              <DropdownMenu.Item onclick={() => sqlStore.open("")}
                ><FileCode aria-hidden="true" />{t("sql.editor.newQuery")}</DropdownMenu.Item
              >
            </DropdownMenu.Group>
            <DropdownMenu.Group>
              <DropdownMenu.Label class="text-xs text-muted-foreground"
                >{t("sql.editor.templates")}</DropdownMenu.Label
              >
              {#each SQL_SNIPPETS as snippet (snippet.label)}
                <DropdownMenu.Item onclick={() => sqlStore.open(t(snippet.sql))}
                  ><FileCode aria-hidden="true" />{t(snippet.label)}</DropdownMenu.Item
                >
              {/each}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                variant="ghost"
                size="sm"
                disabled={sqlStore.history.length === 0}
                title={t("sql.editor.history")}
                aria-label={t("sql.editor.history")}
                {...props}
                ><History data-icon="inline-start" aria-hidden="true" /><span
                  class="hidden 2xl:inline">{t("sql.editor.history")}</span
                ></Button
              >
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-96">
            <DropdownMenu.Label class="text-xs text-muted-foreground"
              >{t("sql.editor.recentlyRun")}</DropdownMenu.Label
            >
            {#each sqlStore.history as item, i (i)}
              <DropdownMenu.Item
                class="font-mono text-[0.8125rem]"
                onclick={() => sqlStore.open(item)}
                ><span class="truncate">{firstLine(item)}</span></DropdownMenu.Item
              >
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>

      <div class="order-2 flex lg:order-4">
        <Button
          variant="outline"
          size="sm"
          class="rounded-r-none"
          onclick={save}
          title={`${t("common.save")} (${mod}+S)`}
        >
          <Save data-icon="inline-start" aria-hidden="true" />
          <span class="max-sm:sr-only">{t("common.save")}</span>
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                variant="outline"
                size="icon-sm"
                class="rounded-l-none border-l-0"
                aria-label={t("sql.editor.saveMore")}
                {...props}
              >
                <ChevronDown />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-52">
            <DropdownMenu.Item
              disabled={!sqlStore.draft.trim()}
              onclick={() => openDialog({ mode: "save" })}
            >
              <Save aria-hidden="true" />
              {t("sql.editor.saveAsNew")}
            </DropdownMenu.Item>
            {#if sqlStore.current}
              <DropdownMenu.Item
                onclick={() => openDialog({ mode: "rename", query: sqlStore.current! })}
              >
                <Pencil aria-hidden="true" />
                {t("sql.editor.rename")}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>

      <!-- Phones only: ends the first row, so "run as" starts the second. -->
      <div class="order-3 h-0 basis-full sm:hidden" aria-hidden="true"></div>
      <div class="order-5 ml-auto flex items-center gap-2 sm:ml-0">
        {#if running}
          <Button variant="outline" onclick={stop} title={t("sql.editor.stopTitle")}>
            <Square data-icon="inline-start" aria-hidden="true" />{t("sql.editor.stop")}
          </Button>
        {/if}
        <Button
          onclick={run}
          disabled={running}
          title={t("sql.editor.runTitle", { shortcut: `${mod}+Enter` })}
          class="sm:min-w-28"
        >
          {#if running}<LoaderCircle
              data-icon="inline-start"
              class="animate-spin"
              aria-hidden="true"
            />{/if}
          {#if !running}<Play data-icon="inline-start" aria-hidden="true" />{/if}{running
            ? t("sql.editor.running")
            : runsSelection
              ? t("sql.editor.runSelection")
              : t("sql.editor.run")}
        </Button>
      </div>
    </div>

    <Resizable.PaneGroup
      direction="vertical"
      class="min-h-0 flex-1"
      autoSaveId="nelcota-sql-layout"
    >
      <Resizable.Pane defaultSize={42} minSize={20}>
        <div class="flex h-full min-h-0 flex-col">
          <div class="min-h-0 flex-1">
            <p class="px-4 py-2 text-sm text-warning">{t("sql.editor.migrationWarning")}</p>
            <CodeEditor
              bind:value={() => sqlStore.draft, (sql) => sqlStore.setDraft(sql)}
              {schema}
              {defaultSchema}
              {errorAt}
              onrun={run}
              oncursor={(next) => (cursor = next)}
            />
          </div>
          <EditorStatus {cursor} shortcut={`${mod}+Enter`} />
        </div>
      </Resizable.Pane>
      <Resizable.Handle withHandle aria-label={t("sql.editor.resize")} />
      <Resizable.Pane
        bind:this={resultsPane}
        defaultSize={RESULTS_SIZE}
        minSize={20}
        collapsible
        collapsedSize={0}
      >
        <p class="sr-only" role="status" aria-atomic="true">
          {running
            ? t("sql.editor.running")
            : response && "results" in response
              ? t("sql.results.completed", { ms: elapsed })
              : ""}
        </p>
        <!-- Keyboard users need a Tab stop to scroll results, including the empty
         state; this named region intentionally has a nonnegative tabindex. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          bind:this={resultsRegion}
          class="relative h-full min-h-0 overflow-auto bg-card focus-visible:outline-offset-[-2px]"
          role="region"
          tabindex="0"
          aria-label={t("sql.results.label")}
          aria-busy={running}
        >
          {#if running}
            <div
              class="pointer-events-none sticky top-0 z-20 h-0.5 overflow-hidden bg-brand/15"
              aria-hidden="true"
            >
              <div class="animate-progress h-full w-2/5 bg-brand"></div>
            </div>
          {/if}
          {#if !response}
            <EmptyState
              title={t("sql.results.emptyTitle")}
              icon={FileCode}
              description={t("sql.results.emptyDescription")}
            />
          {/if}
          {#if !!response && "error" in response}
            <div class="p-4" role="alert">
              <div class="rounded-2xl bg-destructive/10 px-4 py-3 text-sm">
                <p class="mb-1 font-medium text-destructive">{t("sql.results.failed")}</p>
                <p class="font-mono text-[0.8125rem] leading-relaxed text-destructive">
                  {#if response.error.code}{response.error.code}:{" "}{/if}{response.error.message}
                </p>
                {#if errorLine !== null}<p class="mt-2 text-muted-foreground">
                    {t("sql.editor.errorHere", { line: errorLine })}
                  </p>{/if}
                {#if !(errorLine !== null) && response.error.position}<p
                    class="mt-2 text-muted-foreground"
                  >
                    {t("sql.results.position", { position: response.error.position })}
                  </p>{/if}
                {#if response.error.detail}<p class="mt-2 text-muted-foreground">
                    {response.error.detail}
                  </p>{/if}
                {#if response.error.hint}<p class="mt-2 text-muted-foreground">
                    {t("sql.results.hint", { hint: response.error.hint })}
                  </p>{/if}
              </div>
            </div>
          {/if}
          {#if !!response && !("error" in response) && "results" in response}
            {#if response.results_truncated}
              <p class="border-b px-4 py-2.5 text-sm text-warning" role="status">
                {t("sql.results.batchTruncated")}
              </p>
            {/if}
            {#if response.results.length === 0}
              <p class="border-b px-4 py-2.5 text-sm text-muted-foreground">
                {t("sql.results.noRows")} · <span class="tabular-nums">{elapsed} ms</span>
              </p>
            {/if}
            <div bind:this={resultsContent}>
              {#each response.results as result, resultIndex (result)}
                <div
                  class="flex min-h-10 items-center gap-2 border-b px-4 py-1 text-sm text-muted-foreground"
                >
                  <span class="tabular-nums">
                    {#if response.results.length > 1}{t("sql.results.resultOf", {
                        index: resultIndex + 1,
                        total: response.results.length,
                      })}
                      ·
                    {/if}{t("sql.results.rows", { count: result.count })}{#if result.truncated}<span
                        class="text-warning"
                      >
                        {t("sql.results.truncated")}</span
                      >{/if} · {elapsed} ms
                  </span>
                  {#if result.columns.length}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                          <Button variant="ghost" size="sm" class="ml-auto" {...props}
                            ><Download data-icon="inline-start" aria-hidden="true" />{t(
                              "common.export",
                            )}</Button
                          >
                        {/snippet}
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end" class="w-40">
                        <DropdownMenu.Item onclick={() => exportResult(result, resultIndex, "csv")}
                          >CSV</DropdownMenu.Item
                        >
                        <DropdownMenu.Item onclick={() => exportResult(result, resultIndex, "json")}
                          >JSON</DropdownMenu.Item
                        >
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  {/if}
                </div>
                {#if result.columns.length}
                  <ResultTable
                    {result}
                    {resultIndex}
                    scrollElement={() => resultsRegion}
                    scrollMargin={rowOffsets[resultIndex] ?? 0}
                    ondetail={(title, value) => {
                      detail = { title, value };
                      detailOpen = true;
                    }}
                  />
                  {#if result.rows.length === 0}
                    <!-- Headers alone looked like a rendering glitch; say the query just matched nothing. -->
                    <p class="border-b px-4 py-6 text-center text-sm text-muted-foreground">
                      {t("sql.results.noMatchingRows")}
                    </p>
                  {/if}
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </Resizable.Pane>
    </Resizable.PaneGroup>
  </div>
</div>

<SaveQueryDialog
  bind:open={dialogOpen}
  title={dialog?.mode === "rename" ? t("sql.dialog.renameTitle") : t("sql.dialog.saveTitle")}
  initialName={dialog?.mode === "rename" ? (dialog.query?.name ?? "") : ""}
  confirmLabel={dialog?.mode === "rename" ? t("sql.dialog.renameConfirm") : t("common.save")}
  onsubmit={submitName}
/>

{#if toDelete}
  <ConfirmDialog
    bind:open={deleteOpen}
    title={t("sql.dialog.deleteTitle", { name: toDelete.name })}
    description={t("sql.dialog.deleteDescription")}
    confirmLabel={t("common.delete")}
    destructive
    onconfirm={() => sqlStore.remove(toDelete!.id)}
  />
{/if}

{#if toDeleteDraft}
  <ConfirmDialog
    bind:open={deleteDraftOpen}
    title={t("common.unsavedTitle")}
    description={t("sql.editor.discardDraft")}
    confirmLabel={t("common.discard")}
    destructive
    onconfirm={() => sqlStore.removeDraft(toDeleteDraft!.id)}
  />
{/if}
{#if detail}<CellDetailDialog
    bind:open={detailOpen}
    title={detail.title}
    value={detail.value}
  />{/if}
