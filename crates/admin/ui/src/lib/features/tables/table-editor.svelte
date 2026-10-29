<script lang="ts">
  import { requiredValue, type Column, type RowData } from "$lib/contracts";
  import { onMount, untrack } from "svelte";
  import { ShieldAlert, KeyRound, Eye } from "@lucide/svelte";

  import { toast } from "svelte-sonner";
  import {
    TableSidebar,
    TableToolbar,
    FilterChips,
    DataGrid,
    GridFooter,
    SelectionBar,
    GridState,
    RowSheet,
    FilterBar,
    CreateTableSheet,
    StructureView,
    TablesHome,
  } from "$lib/features/tables/components";

  import { ConfirmDialog, type RunAsLabels, type Viewer } from "$lib/components/shared";
  import {
    TableCatalog,
    deniedViewer,
    RecentTables,
    HiddenColumns,
    filtersParam,
    filtersToSearch,
    parseFilters,
    type TableFilter,
    TableRows,
    tableRowsApi,
    parseTableView,
    tableViewSearch,
    type TableView,
  } from "$lib/features/tables/model";

  import { href, navigate, route, pageAfterEmpty } from "$lib/navigation";
  import { cn } from "$lib/components/component-props";

  import { errorMessage, t } from "$lib/i18n/index.svelte";

  let { name, view = "data" }: { name?: string; view?: "data" | "structure" } = $props();

  const tablesResource = new TableCatalog();
  const tables = $derived(tablesResource.data?.tables ?? []);
  const tablesLoading = $derived(tablesResource.loading);
  const tablesError = $derived(
    Boolean(tablesResource.error) === true ? errorMessage(tablesResource.error) : "",
  );
  const emptyCatalog = $derived(
    tablesResource.loaded &&
      Boolean(tablesLoading) === false &&
      Boolean(tablesError) === false &&
      Boolean(tables.length) === false &&
      (name == null || name === ""),
  );
  const rows = new TableRows(tableRowsApi);
  let active = true;
  const data = $derived(rows.data);
  const loading = $derived(rows.loading);
  const savingCell = $derived(rows.saving);
  // Who the grid reads as (not persisted: a reload goes back to full access).
  let viewer = $state<Viewer>({ mode: "owner", user: null });
  const viewing = $derived(viewer.mode !== "owner");
  const viewerLabels: RunAsLabels = $derived({
    label: t("tables.viewAs.label"),
    owner: t("tables.viewAs.owner"),
    ownerHint: t("tables.viewAs.ownerHint"),
    anon: t("tables.viewAs.anon"),
    anonHint: t("tables.viewAs.anonHint"),
    authenticated: t("tables.viewAs.authenticated"),
    authenticatedHint: t("tables.viewAs.authenticatedHint"),
    asVisitor: t("tables.viewAs.asVisitor"),
    asUser: (email: string) => t("tables.viewAs.asUser", { email }),
    ownerTrigger: t("tables.viewAs.ownerTrigger"),
    pickTitle: t("tables.viewAs.pickTitle"),
    search: t("tables.viewAs.search"),
    empty: t("tables.viewAs.empty"),
    noUsers: t("tables.viewAs.noUsers"),
    loading: t("tables.viewAs.loading"),
  });
  // A role without a GRANT is the answer to "what do they see", not a failure.
  const denied = $derived.by(() => {
    const viewer = deniedViewer(rows.error);
    if (viewer === null) return "";
    return t(
      viewer === "anon" ? "tables.viewAs.denied.anon" : "tables.viewAs.denied.authenticated",
    );
  });
  const error = $derived(
    Boolean(rows.error) && Boolean(denied) === false ? errorMessage(rows.error) : "",
  );

  function setViewer(next: Viewer) {
    rows.clear();
    viewer = next;
  }
  // A deliberate access-review link starts read-only, without overriding later manual role changes.
  let lastAccessPreview: string | undefined;
  $effect(() => {
    const preview = route.query.get("_preview");
    const key = JSON.stringify([name, view, preview]);
    if (key === lastAccessPreview) return;
    lastAccessPreview = key;
    if (view !== "data" || preview !== "anon") return;
    untrack(() => setViewer({ mode: "anon", user: null }));
  });
  const tableView = $derived(parseTableView(route.query));
  const page = $derived(tableView.page);
  const size = $derived(tableView.size);
  const sort = $derived(tableView.sort);
  const selected = $derived(rows.selected);

  let sheetOpen = $state(false);
  let sheetRow = $state<RowData | null>(null);
  let confirmOpen = $state(false);
  let filterOpen = $state(false);
  let filterPreset = $state<string | undefined>(undefined);
  let createOpen = $state(false);

  // Hidden columns, remembered per table.
  const hidden = new HiddenColumns();
  $effect(() => {
    if (name != null && name !== "") hidden.load(name);
  });
  $effect(() => {
    if (data != null) hidden.prune(data.table.columns.map((c) => c.name));
  });

  // Filters come from the URL (`?price=gte.10`): links can be shared and the
  // browser's back button works. The text key avoids reloading without a real change.
  const filters = $derived(parseFilters(route.query));
  const filtersKey = $derived(filtersToSearch(filters));

  // The tables opened last in this browser, offered again on the list page.
  // Older panels kept only one name under LAST_TABLE; it seeds the list once.
  const recent = new RecentTables();
  $effect(() => {
    if (name == null || name === "" || recent.names[0] === name) return;
    recent.remember(name);
  });

  async function loadTables() {
    if (Boolean(active) === false) return;
    await tablesResource.reload();
  }

  onMount(() => {
    void loadTables();
    if (route.query.get("create") === "true") {
      createOpen = true;
      navigate("/tables", true);
    }
    return () => {
      active = false;
      tablesResource.cancel();
    };
  });

  async function onCreated(table: string) {
    const origin = route.revision;
    if (Boolean(active) === false) return;
    await loadTables();
    if (Boolean(active) === false || route.revision !== origin) return;
    navigate(`/tables/${encodeURIComponent(table)}`);
  }

  async function onRenamed(table: string) {
    const origin = route.revision;
    if (Boolean(active) === false) return;
    await loadTables();
    if (Boolean(active) === false || route.revision !== origin) return;
    navigate(`/tables/${encodeURIComponent(table)}/structure`, true);
  }

  async function onDropped() {
    const origin = route.revision;
    if (Boolean(active) === false) return;
    await loadTables();
    if (Boolean(active) === false || route.revision !== origin) return;
    navigate("/tables");
  }

  /** Current order and filters, in the API format (listing and export). */
  function rowsParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (sort != null) {
      params.set("sort", sort.column);
      if (sort.desc) params.set("desc", "true");
    }
    const f = filtersParam(filters);
    if (f != null && f !== "") params.set("filters", f);
    return params;
  }

  async function load() {
    if (Boolean(active) === false) return;
    rows.setTable(name);
    if (name == null || name === "" || view !== "data") return;
    const params = rowsParams();
    params.set("page", String(page));
    params.set("size", size);
    if (viewer.mode !== "owner") params.set("as", viewer.mode);
    if (viewer.mode === "authenticated" && viewer.user != null) params.set("user", viewer.user.id);
    await rows.load(name, params);
  }

  // Reload when the table, page, size, sort or filters change.
  $effect(() => {
    void [
      name,
      view,
      page,
      size,
      sort?.column,
      sort?.desc,
      filtersKey,
      viewer.mode,
      viewer.user?.id,
    ];
    void untrack(load);
    return () => rows.cancel();
  });

  // A page past the first that came back empty (its last rows were deleted,
  // or a stale link) moves to the last page instead of reading "empty table".
  $effect(() => {
    if (data == null || loading || data.rows.length > 0 || data.page !== page) return;
    const next = pageAfterEmpty({
      page: page,
      size: data.size,
      total: data.total,
      exact: data.total_exact,
    });
    if (next !== null) untrack(() => updateView({ page: next }));
  });

  function setFilters(next: TableFilter[]) {
    filterOpen = false;
    filterPreset = undefined;
    const search = tableViewSearch(new URLSearchParams(filtersToSearch(next)), {
      page: 0,
      size,
      sort,
    });
    navigate(
      `/tables/${encodeURIComponent(requiredValue(name, "name"))}${search !== "" ? `?${search}` : ""}`,
    );
  }

  const exportHref = (format: "csv" | "json") => {
    const params = rowsParams();
    params.set("format", format);
    return href(`/api/tables/${encodeURIComponent(requiredValue(name, "name"))}/export?${params}`);
  };

  /** Link to the row referenced by the foreign key. */
  const referenceHref = (column: Column, value: string) =>
    href(
      `/tables/${encodeURIComponent(requiredValue(column.references, "required operation value").table)}?${filtersToSearch([{ column: requiredValue(column.references, "required operation value").column, op: "eq", value }])}`,
    );

  function toggledSort(column: string) {
    if (sort?.column !== column) return { column, desc: false };
    return sort.desc ? null : { column, desc: true };
  }

  function toggleSort(column: string) {
    updateView({ page: 0, sort: toggledSort(column) });
  }

  function setSort(column: string, direction: "asc" | "desc" | null) {
    updateView({
      page: 0,
      sort: direction != null ? { column, desc: direction === "desc" } : null,
    });
  }

  function updateView(patch: Partial<TableView>) {
    const search = tableViewSearch(route.query, patch);
    navigate(
      `/tables/${encodeURIComponent(requiredValue(name, "name"))}${search !== "" ? `?${search}` : ""}`,
    );
  }

  /** Column menu: opens the filter bar with a row for that column. */
  function filterBy(column: string) {
    filterPreset = column;
    filterOpen = true;
  }

  async function commitCell(pk: RowData, column: string, value: string | null) {
    try {
      const count = await rows.edit(pk, column, value);
      if (count !== undefined) toast.success(t("tables.toast.rowsUpdated", { count }));
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }

  async function deleteSelected() {
    try {
      const count = await rows.deleteSelected();
      if (count !== undefined) toast.success(t("tables.toast.rowsDeleted", { count }));
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }

  function openSheet(row: RowData | null) {
    sheetRow = row;
    sheetOpen = true;
  }
</script>

<div
  class={cn(
    "mx-auto flex h-full min-h-0 w-full max-w-page px-4 pt-4 pb-4 sm:px-6 lg:px-8",
    emptyCatalog ? "flex-col" : "gap-3",
  )}
>
  {#if !emptyCatalog}
    <!-- The home lists every table itself, so the sidebar list only comes with
         an open table (or alone when the catalog failed, to offer the retry). -->
    {#if name || tablesError}
      <TableSidebar
        {tables}
        current={name}
        phone={!name && !!tablesError}
        loading={tablesLoading}
        error={tablesError}
        onretry={loadTables}
        oncreate={() => (createOpen = true)}
      />
    {/if}
  {/if}

  <section
    class={cn(
      "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
      emptyCatalog ? "flex" : "rounded-3xl bg-card",
      !emptyCatalog && (name || !tablesError ? "flex" : "hidden lg:flex"),
    )}
  >
    {#if !name && !tablesError}
      <TablesHome
        {tables}
        loading={tablesLoading || !tablesResource.loaded}
        recent={recent.names}
        oncreate={() => (createOpen = true)}
        onchanged={loadTables}
      />
    {/if}
    {#if !!name}
      <TableToolbar
        {name}
        {view}
        {data}
        filterCount={filters.length}
        {viewing}
        bind:filterOpen
        loading={loading || savingCell}
        hiddenColumns={hidden.names}
        ontogglecolumn={(column) => hidden.toggle(column)}
        onshowallcolumns={() => hidden.showAll()}
        {exportHref}
        onreload={load}
        oninsert={() => openSheet(null)}
        {viewer}
        {viewerLabels}
        onviewer={setViewer}
        listedRls={tables.find((entry) => entry.name === name)?.rls}
      />

      {#if view === "structure"}
        <div class="min-h-0 flex-1 overflow-auto">
          <StructureView
            {name}
            policies={tables.find((entry) => entry.name === name)?.rls.policies}
            onrenamed={onRenamed}
            ondropped={onDropped}
            onaltered={loadTables}
          />
        </div>
      {/if}
      {#if !(view === "structure")}
        {#if filterOpen && data}
          {#key filterPreset}
            <FilterBar
              columns={data.table.columns}
              {filters}
              preset={filterPreset}
              onapply={setFilters}
              onclose={() => {
                filterOpen = false;
                filterPreset = undefined;
              }}
            />
          {/key}
        {/if}
        {#if !(filterOpen && data) && (filters.length || sort)}
          <FilterChips
            {filters}
            {sort}
            onchange={setFilters}
            onclearsort={() => setSort("", null)}
          />
        {/if}

        {#if data && selected.size > 0}
          <SelectionBar
            table={name}
            columns={data.table.columns.map((c) => c.name)}
            rows={[...selected]
              .toSorted((a, b) => a - b)
              .flatMap((i): RowData[] => {
                const row = data?.rows[i];
                return row === undefined ? [] : [row];
              })}
            deletable={data.table.editable && !loading && !savingCell}
            onclear={() => (rows.selected = new Set())}
            ondelete={() => (confirmOpen = true)}
          />
        {/if}

        {#if viewing}
          <p
            class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground"
          >
            <Eye class="size-4 shrink-0" aria-hidden="true" />
            <span
              >{viewer.mode === "anon"
                ? t("tables.viewAs.bannerVisitor")
                : t("tables.viewAs.bannerUser", { email: viewer.user?.email ?? "" })}</span
            >
            <button
              type="button"
              class="cursor-pointer text-foreground underline underline-offset-4"
              onclick={() => setViewer({ mode: "owner", user: null })}
              >{t("tables.viewAs.back")}</button
            >
          </p>
        {/if}
        {#if !viewing && data?.table.exposed_without_rls}
          <p
            class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive"
          >
            <ShieldAlert class="size-4 shrink-0" />{t(
              data.table.kind === "table" ? "tables.editor.noRls" : "tables.editor.noRowProtection",
            )}
          </p>
        {/if}
        {#if !viewing && !data?.table.exposed_without_rls && data && !data.table.editable && data.table.kind === "table"}
          <p
            class="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground"
          >
            <KeyRound class="size-4 shrink-0" />{t("tables.editor.noPrimaryKey")}
          </p>
        {/if}

        <div class="relative min-h-0 flex-1 overflow-auto" aria-busy={loading || savingCell}>
          <!-- Reload (order, filter, page): a bar at the top and a dimmed grid,
               so the old data does not look like the new one. -->
          {#if (loading || savingCell) && data}
            <div
              class="pointer-events-none sticky top-0 z-20 h-0.5 overflow-hidden bg-brand/15"
              aria-hidden="true"
            >
              <div class="animate-progress h-full w-2/5 bg-brand"></div>
            </div>
          {/if}
          {#if denied}
            <p class="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">{denied}</p>
          {/if}
          {#if !denied && error && !data}
            <GridState state="error" message={error} onretry={load} />
          {/if}
          {#if !denied && !(error && !data) && !data}
            <GridState state="loading" />
          {/if}
          {#if !denied && !(error && !data) && !!data}
            {#if error}<GridState state="error" message={error} onretry={load} />{/if}
            <div class={["transition-opacity", loading && "opacity-60"]}>
              <DataGrid
                {data}
                disabled={loading || savingCell}
                {sort}
                hidden={hidden.names}
                bind:selected={rows.selected}
                onsort={toggleSort}
                onsortset={setSort}
                onfilter={filterBy}
                onhide={(column) => hidden.hide(column)}
                onexpand={openSheet}
                oncommit={commitCell}
                {referenceHref}
              />
            </div>
            {#if data.rows.length === 0}
              {#if filters.length}
                <GridState state="no-match" onclearfilters={() => setFilters([])} />
              {/if}
              {#if !filters.length && viewing}
                <p class="p-8 text-center text-sm text-muted-foreground">
                  {t("tables.viewAs.hidden")}
                </p>
              {/if}
              {#if !filters.length && !viewing}
                <GridState
                  state="empty"
                  table={name}
                  insertable={data.table.insertable}
                  oninsert={() => openSheet(null)}
                />
              {/if}
            {/if}
          {/if}
        </div>

        {#if data}<GridFooter
            {data}
            {page}
            {size}
            disabled={loading || savingCell}
            onpage={(page) => updateView({ page })}
            onsize={(size) => updateView({ page: 0, size })}
          />{/if}
      {/if}
    {/if}
  </section>
</div>

<CreateTableSheet bind:open={createOpen} oncreated={onCreated} />

{#if data && name}
  <RowSheet
    bind:open={sheetOpen}
    table={name}
    columns={data.table.columns}
    primaryKey={data.table.primary_key}
    row={sheetRow}
    onsaved={load}
  />
  <ConfirmDialog
    bind:open={confirmOpen}
    title={t("tables.editor.deleteTitle", { count: selected.size })}
    description={t("tables.editor.deleteDescription")}
    confirmLabel={t("common.delete")}
    destructive
    onconfirm={deleteSelected}
  />
{/if}
