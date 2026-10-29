<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Skeleton, Button } from "$lib/components/ui";

  import { Plus, ShieldAlert, ShieldCheck, CircleCheck, ChevronDown, Search } from "@lucide/svelte";

  import {
    SearchField,
    PageHeader,
    ConfirmDialog,
    EmptyState,
    LoadError,
  } from "$lib/components/shared";
  import { toast } from "svelte-sonner";

  import {
    RecentlyBlocked,
    AttentionPanel,
    PolicyTableCard,
    PolicySheet,
  } from "$lib/features/policies/components";

  import TechnicalToggle from "$lib/shared/schema/components/technical-toggle.svelte";
  import { href, navigate, route } from "$lib/navigation/router.svelte";
  import {
    PolicyCatalog,
    type PolicyDef,
    attentionItems,
    byUrgency,
    inFilter,
    parseFilter,
    policyStats,
    type PolicyFilter,
  } from "$lib/features/policies/model";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  // Lead with problems and their fixes, then list tables and rules;
  // keep supporting help at the end.
  const resource = new PolicyCatalog();
  const data = $derived(resource.data);
  const error = $derived(resource.error == null ? "" : errorMessage(resource.error));
  const loading = $derived(resource.loading);

  // Sidebar filters use `?filter=`; keep search terms in the URL as well,
  // including links from overview alerts through `?table=`.
  const appliedSearch = $derived(route.query.get("q") ?? route.query.get("table") ?? "");
  const rlsFilter = $derived(parseFilter(route.query.get("filter")));
  let search = $state("");
  // Synchronize the field only when the URL changes its value, so a debounced
  // search cannot erase a space while the user types.
  $effect(() => {
    const applied = appliedSearch;
    untrack(() => {
      if (search.trim() !== applied) search = applied;
    });
  });
  let debounce: ReturnType<typeof setTimeout>;
  $effect(() => () => clearTimeout(debounce));
  const SEARCH_DELAY_MS = 250;

  function setFilters(filter: PolicyFilter, query = search, replace = false) {
    clearTimeout(debounce);
    const params = new URLSearchParams();
    if (query.trim() !== "") params.set("q", query.trim());
    if (filter !== "all") params.set("filter", filter);
    navigate(`/policies${params.size > 0 ? `?${params}` : ""}`, replace);
  }
  function onSearch() {
    clearTimeout(debounce);
    debounce = setTimeout(() => setFilters(rlsFilter, search, true), SEARCH_DELAY_MS);
  }

  const attention = $derived(data == null ? [] : attentionItems(data));
  const showAttention = $derived(
    attention.length > 0 && (rlsFilter === "all" || rlsFilter === "attention"),
  );
  const stats = $derived(policyStats(data?.tables ?? []));
  const visible = $derived(
    byUrgency(data?.tables ?? []).filter(
      (table) =>
        table.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        inFilter(table, rlsFilter),
    ),
  );
  const filtering = $derived(search.trim() !== "" || rlsFilter !== "all");

  // Provide a status legend because touchscreens cannot open badge tooltips.
  const LEGEND = [
    { state: "ok", icon: ShieldCheck, tone: "text-success" },
    { state: "warn", icon: ShieldAlert, tone: "text-warning" },
    { state: "danger", icon: ShieldAlert, tone: "text-destructive" },
  ] as const;

  async function load() {
    await resource.reload();
  }
  onMount(() => {
    void load();
    return () => resource.cancel();
  });

  // The rule sheet tracks its target table and edited rule (`null` for a new rule).
  let sheetOpen = $state(false);
  let sheetTable = $state("");
  let editing = $state<PolicyDef | null>(null);
  let toDelete = $state<{ table: string; policy: string } | null>(null);
  let deleteOpen = $state(false);

  function openSheet(table: string, policy: PolicyDef | null) {
    sheetTable = table;
    editing = policy;
    sheetOpen = true;
  }

  function requestDelete(table: string, policy: string) {
    toDelete = { table, policy };
    deleteOpen = true;
  }

  // Ativar o RLS sem nenhuma regra esconde todas as linhas de anon/authenticated:
  // pergunta antes. Com regras, aplica direto.
  let enabling = $state<string | null>(null);
  let toEnable = $state<string | null>(null);
  let enableOpen = $state(false);

  function requestEnableRls(table: string) {
    const policies = data?.tables.find((item) => item.name === table)?.policies.length ?? 0;
    if (policies > 0) {
      enableRls(table).catch(() => {});
      return;
    }
    toEnable = table;
    enableOpen = true;
  }

  /** Reject after displaying the error to keep the confirmation dialog open. */
  async function enableRls(table: string) {
    if (enabling !== null) return;
    enabling = table;
    try {
      await resource.enableRls(table);
      toast.success(t("policies.rlsEnabled", { table }));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    } finally {
      enabling = null;
    }
  }

  async function dropPolicy() {
    if (toDelete == null) return;
    try {
      await resource.dropPolicy(toDelete.table, toDelete.policy);
      toast.success(t("policies.deleted", { name: toDelete.policy }));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }
</script>

<div
  class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0"
>
  <PageHeader title={t("policies.title")} description={t("policies.description")}>
    {#snippet actions()}<TechnicalToggle />{/snippet}
  </PageHeader>

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if data == null && loading}
    <Skeleton class="h-5 w-72 max-w-full" />
    <Skeleton class="h-40 rounded-3xl" />
    <Skeleton class="h-56 rounded-3xl" />
  {/if}

  {#if data}
    <p class="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-muted-foreground">
      <span
        >{t("policies.summary.protected", {
          protected: stats.protected,
          count: stats.tables,
        })}</span
      >
      <span aria-hidden="true">·</span>
      <span>{t("policies.count", { count: stats.rules })}</span>
      {#if attention.length === 0 && data.tables.length > 0}
        <span aria-hidden="true">·</span>
        <span class="flex items-center gap-1.5 text-success"
          ><CircleCheck class="size-4" aria-hidden="true" />{t(
            "policies.filterEmpty.attention.title",
          )}</span
        >
      {/if}
    </p>

    {#if showAttention}
      <AttentionPanel
        items={attention}
        {enabling}
        onenable={requestEnableRls}
        oncreate={(table) => openSheet(table, null)}
      />
    {/if}

    {#if data.tables.length === 0}
      <EmptyState
        class="rounded-3xl bg-card"
        icon={ShieldCheck}
        title={t("policies.noTables")}
        description={t("policies.noTablesHint")}
        >{#snippet actions()}<Button href={href("/tables?create=true")}
            ><Plus data-icon="inline-start" aria-hidden="true" />{t(
              "tables.editor.newTable",
            )}</Button
          >{/snippet}</EmptyState
      >
    {/if}

    {#if data.tables.length > 0}
      <div class="grid gap-6 *:min-w-0 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <section class="grid min-w-0 gap-4" aria-labelledby="policies-tables">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 id="policies-tables" class="text-lg font-semibold">{t("policies.tables")}</h2>
            <div class="w-full sm:w-72">
              <SearchField bind:value={search} oninput={onSearch} label={t("policies.search")} />
            </div>
          </div>

          {#if visible.length === 0 && filtering && search.trim() === "" && (rlsFilter === "attention" && showAttention) === false}
            <!-- Explain that an empty attention filter means no outstanding problems. -->
            <EmptyState
              class="rounded-3xl bg-card"
              icon={ShieldCheck}
              title={t(
                `policies.filterEmpty.${rlsFilter === "all" ? "attention" : rlsFilter}.title`,
              )}
              description={t(
                `policies.filterEmpty.${rlsFilter === "all" ? "attention" : rlsFilter}.text`,
              )}
              >{#snippet actions()}<Button variant="outline" onclick={() => setFilters("all", "")}
                  >{t("policies.showAll")}</Button
                >{/snippet}</EmptyState
            >
          {/if}
          {#if visible.length === 0 && search.trim() !== ""}
            <EmptyState class="rounded-3xl bg-card" icon={Search} title={t("common.noMatches")}
              >{#snippet actions()}<Button variant="outline" onclick={() => setFilters("all", "")}
                  >{t("common.clearFilters")}</Button
                >{/snippet}</EmptyState
            >
          {/if}

          {#each visible as table (table.name)}
            <PolicyTableCard
              {table}
              {enabling}
              onenable={() => requestEnableRls(table.name)}
              oncreate={() => openSheet(table.name, null)}
              onedit={(policy) => openSheet(table.name, policy)}
              ondelete={(policy) => requestDelete(table.name, policy)}
            />
          {/each}
        </section>

        <aside class="grid gap-4 xl:sticky xl:top-6">
          <RecentlyBlocked />
          {#if data.anon_functions.length > 0}
            <section
              class="grid gap-2 rounded-3xl bg-card p-5"
              aria-labelledby="policies-anon-functions"
            >
              <h2 id="policies-anon-functions" class="text-base font-semibold">
                {t("policies.anonFunctions")}
              </h2>
              <p class="font-mono text-sm [overflow-wrap:anywhere]">
                {data.anon_functions.join(", ")}
              </p>
              <p class="text-sm text-muted-foreground">
                {t("policies.anonFunctionsHint")}
                <code class="text-[0.8125rem] text-foreground"
                  >revoke execute on function f() from public</code
                >.
              </p>
            </section>
          {/if}
        </aside>
      </div>

      <details class="group rounded-3xl bg-card">
        <summary
          class="flex cursor-pointer list-none items-center gap-3 px-5 py-4 text-base font-semibold sm:px-6 [&::-webkit-details-marker]:hidden"
        >
          <ChevronDown
            class="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
            aria-hidden="true"
          />
          {t("policies.legend.title")}
        </summary>
        <div class="grid gap-4 px-5 pb-5 sm:px-6">
          <p class="text-sm text-muted-foreground">{t("policies.legend.intro")}</p>
          <dl class="grid gap-4 sm:grid-cols-3">
            {#each LEGEND as item (item.state)}
              <div class="grid content-start gap-1">
                <dt class={["flex items-center gap-1.5 text-base font-medium", item.tone]}>
                  <item.icon class="size-4 shrink-0" aria-hidden="true" />{t(
                    `policies.plain.state.${item.state}`,
                  )}
                </dt>
                <dd class="text-sm text-muted-foreground">
                  {t(`policies.plain.stateHint.${item.state}`)}
                </dd>
              </div>
            {/each}
          </dl>
        </div>
      </details>
    {/if}
  {/if}
</div>

<PolicySheet
  bind:open={sheetOpen}
  table={sheetTable}
  original={editing}
  existingNames={data?.tables
    .find((table) => table.name === sheetTable)
    ?.policies.map((policy) => policy.name) ?? []}
  onsaved={load}
/>
{#if toDelete}
  <ConfirmDialog
    bind:open={deleteOpen}
    title={t("policies.confirmDelete.title", { name: toDelete.policy })}
    description={t("policies.confirmDelete.description", { table: toDelete.table })}
    confirmLabel={t("policies.confirmDelete.confirm")}
    destructive
    onconfirm={dropPolicy}
  />
{/if}
{#if toEnable}
  {@const table = toEnable}
  <ConfirmDialog
    bind:open={enableOpen}
    title={t("policies.enableRlsEmpty.title", { table })}
    description={t("policies.enableRlsEmpty.description")}
    confirmLabel={t("policies.enableRlsEmpty.confirm")}
    onconfirm={() => enableRls(table)}
  />
{/if}
