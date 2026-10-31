<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import {
    RefreshCw,
    Webhook,
    Plus,
    Pencil,
    Ellipsis,
    KeyRound,
    Trash as Trash2,
  } from "@lucide/svelte";

  import { Button, DropdownMenu, Skeleton, Badge } from "$lib/components/ui";

  import {
    PageHeader,
    EmptyState,
    LoadError,
    Callout,
    ConfirmDialog,
  } from "$lib/components/shared";

  import { route, navigate, href } from "$lib/navigation/router.svelte";
  import { errorMessage, intlLocale, t } from "$lib/i18n/index.svelte";
  import { numberFormat } from "$lib/formatting/intl";
  import { EndpointDialog, SecretDialog, DeliveryHistory } from "$lib/features/webhooks/components";

  import {
    webhooks,
    type EndpointInput,
    eventLabel,
    WebhookInventory,
    type WebhookEndpoint,
    type WebhookSecret,
  } from "$lib/features/webhooks/model";

  // The per-webhook queue limit enforced by the capture trigger
  // (migrations/V19__webhook_queue_admission.sql), and the share of it that
  // shows the warning. The total is shown, so the warning comes early.
  const OUTSTANDING_LIMIT = 10_000;
  const CAPACITY_WARNING = 0.8;
  const count = (value: number) => numberFormat(intlLocale()).format(value);
  const inventory = new WebhookInventory();
  const config = inventory.config,
    history = inventory.history;
  const tab = $derived(route.query.get("tab") === "deliveries" ? "deliveries" : "configuration");
  const endpointFilter = $derived(route.query.get("endpoint") ?? "");
  const statusFilter = $derived(route.query.get("status") ?? "");
  const before = $derived(route.query.get("before") ?? "");
  const query = $derived.by(() => {
    const params = new URLSearchParams();
    if (endpointFilter !== "") params.set("endpoint", endpointFilter);
    if (statusFilter !== "") params.set("status", statusFilter);
    if (before !== "") params.set("before", before);
    return Boolean(params.size) === true ? `?${params}` : "";
  });
  let editorOpen = $state(false),
    editing = $state<WebhookEndpoint | null>(null),
    secret = $state<WebhookSecret | null>(null);
  let busy = $state<string | null>(null),
    confirmOpen = $state(false),
    refreshing = $state(false);
  let confirm = $state<{
    kind: "delete" | "rotate" | "pause" | "clear";
    endpoint?: WebhookEndpoint;
  } | null>(null);

  async function loadConfig() {
    await inventory.loadConfig();
  }
  async function loadHistory() {
    await inventory.loadHistory(query);
  }
  async function reload() {
    await Promise.all([loadConfig(), tab === "deliveries" ? loadHistory() : Promise.resolve()]);
  }
  // Only a manual refresh disables the button; background polling would make it flicker.
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await reload();
    } finally {
      refreshing = false;
    }
  }
  $effect(() => {
    const currentTab = tab,
      currentQuery = query;
    if (currentTab === "deliveries") {
      untrack(() => {
        void inventory.loadHistory(currentQuery);
      });
      return;
    }
    history.cancel();
  });
  onMount(() => {
    const pollIntervalInMs = 5000;

    void loadConfig();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Boolean(config.loading) === false) void loadConfig();
      if (tab === "deliveries" && Boolean(history.loading) === false) void loadHistory();
    }, pollIntervalInMs);
    return () => {
      clearInterval(timer);
      config.cancel();
      history.cancel();
      secret = null;
    };
  });
  function filters(endpoint: string, status: string, cursor = "") {
    const params = new URLSearchParams({ tab: "deliveries" });
    if (endpoint !== "") params.set("endpoint", endpoint);
    if (status !== "") params.set("status", status);
    if (cursor !== "") params.set("before", cursor);
    navigate(`/webhooks?${params}`);
  }
  function edit(endpoint: WebhookEndpoint | null) {
    editing = endpoint;
    editorOpen = true;
  }
  function request(kind: "delete" | "rotate" | "pause" | "clear", endpoint?: WebhookEndpoint) {
    confirm = { kind, endpoint };
    confirmOpen = true;
  }
  const confirmText = {
    delete: {
      title: "webhooks.deleteTitle",
      hint: "webhooks.deleteHint",
      action: "webhooks.deleteConfirm",
    },
    rotate: {
      title: "webhooks.rotateTitle",
      hint: "webhooks.rotateHint",
      action: "webhooks.rotate",
    },
    pause: {
      title: "webhooks.pauseTitle",
      hint: "webhooks.pauseHint",
      action: "webhooks.pauseConfirm",
    },
    clear: { title: "webhooks.clearTitle", hint: "webhooks.clearHint", action: "webhooks.clear" },
  } as const;
  const confirmCopy = $derived(confirmText[confirm?.kind ?? "pause"]);
  function input(endpoint: WebhookEndpoint, enabled = endpoint.enabled): EndpointInput {
    return {
      name: endpoint.name,
      table: endpoint.table,
      url: endpoint.url,
      events: endpoint.events,
      max_attempts: endpoint.max_attempts,
      enabled,
    };
  }
  async function enable(endpoint: WebhookEndpoint) {
    if (busy != null && busy !== "") return;
    busy = endpoint.id;
    try {
      await webhooks.update(endpoint.id, input(endpoint, true));
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      busy = null;
    }
  }
  async function performAction(action: NonNullable<typeof confirm>) {
    switch (action.kind) {
      case "clear":
        await webhooks.clear();
        toast.success(t("webhooks.cleared"));
        break;
      case "delete":
        if (action.endpoint != null) {
          await webhooks.remove(action.endpoint.id);
          toast.success(t("webhooks.removed"));
        }
        break;
      case "rotate":
        if (action.endpoint != null) secret = await webhooks.rotate(action.endpoint.id);
        break;
      case "pause":
        if (action.endpoint != null)
          await webhooks.update(action.endpoint.id, input(action.endpoint, false));
        break;
    }
  }

  async function apply() {
    if (confirm == null || (busy != null && busy !== "")) return;
    const action = confirm;
    busy = action.endpoint?.id ?? "clear";
    try {
      await performAction(action);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    } finally {
      busy = null;
    }
  }
  function saved(value?: WebhookSecret) {
    if (value != null) secret = value;
    toast.success(t(value != null ? "webhooks.created" : "webhooks.saved"));
    void reload();
  }
</script>

<div
  class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0"
>
  <PageHeader title={t("webhooks.title")} description={t("webhooks.description")}>
    {#snippet actions()}<Button variant="outline" onclick={refresh} disabled={refreshing}
        ><RefreshCw
          data-icon="inline-start"
          aria-hidden="true"
          class={refreshing ? "animate-spin" : ""}
        />{t("common.refresh")}</Button
      >{#if tab === "configuration"}<Button
          onclick={() => edit(null)}
          disabled={!config.data?.tables.length}
          ><Plus data-icon="inline-start" aria-hidden="true" />{t("webhooks.create")}</Button
        >{/if}{/snippet}
  </PageHeader>
  <!-- The sidebar picks the view; this names it for screen readers (D103). -->
  <h2 class="sr-only">
    {t(tab === "deliveries" ? "webhooks.deliveries" : "webhooks.configuration")}
  </h2>
  {#if config.error}<LoadError
      message={errorMessage(config.error)}
      onretry={loadConfig}
      busy={config.loading}
    />{/if}
  {#if !config.data && config.loading}<Skeleton class="h-40 rounded-3xl" />{/if}
  {#if config.data}
    <p class="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-muted-foreground">
      <span>{t("webhooks.summary.outstanding", { count: config.data.outstanding })}</span>
      <span aria-hidden="true">·</span>
      <span>{t("webhooks.summary.retained", { count: config.data.retained })}</span>
    </p>
    {#if config.data.outstanding >= OUTSTANDING_LIMIT * CAPACITY_WARNING}<Callout
        variant="warning"
        title={t("webhooks.capacity")}
      />{/if}
    {#if tab === "configuration"}
      {#if !config.data.endpoints.length}
        <EmptyState
          class="rounded-3xl bg-card"
          icon={Webhook}
          title={t(config.data.tables.length ? "webhooks.emptyTitle" : "webhooks.noTables")}
          description={t(
            config.data.tables.length ? "webhooks.emptyHint" : "webhooks.noTablesHint",
          )}
        >
          {#snippet actions()}{#if config.data?.tables.length}<Button
                variant="outline"
                onclick={() => edit(null)}
                ><Plus data-icon="inline-start" aria-hidden="true" />{t("webhooks.create")}</Button
              >{/if}{#if !config.data?.tables.length}<Button href={href("/tables?create=true")}
                >{t("tables.editor.newTable")}</Button
              >{/if}{/snippet}
        </EmptyState>
      {/if}
      <div class="grid gap-4 lg:grid-cols-2">
        {#each config.data.endpoints as hook (hook.id)}
          <section class="grid min-w-0 content-start gap-4 rounded-3xl bg-card p-5">
            <header class="flex items-center gap-2">
              <h3 class="min-w-0 flex-1 break-words font-semibold">{hook.name}</h3>
              {#if !hook.table_available}<Badge variant="destructive"
                  >{t("webhooks.tableMissing")}</Badge
                >{/if}
              {#if hook.table_available}<Badge variant={hook.enabled ? "success" : "muted"}
                  >{t(hook.enabled ? "webhooks.enabled" : "webhooks.paused")}</Badge
                >{/if}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger disabled={busy !== null}>
                  {#snippet child({ props })}<Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("common.actionsFor", { name: hook.name })}
                      {...props}><Ellipsis aria-hidden="true" /></Button
                    >{/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-48">
                  <DropdownMenu.Item onclick={() => request("rotate", hook)}
                    ><KeyRound aria-hidden="true" />{t("webhooks.rotate")}</DropdownMenu.Item
                  >
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item variant="destructive" onclick={() => request("delete", hook)}
                    ><Trash2 aria-hidden="true" />{t("webhooks.remove")}</DropdownMenu.Item
                  >
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </header>
            <p class="font-mono text-sm text-muted-foreground">{hook.schema}.{hook.table}</p>
            {#if !hook.table_available}<p class="text-sm text-warning">
                {t("webhooks.missingTable")}
              </p>{/if}
            <p class="break-all text-sm text-muted-foreground">{hook.url}</p>
            <div class="flex flex-wrap gap-2">
              {#each hook.events as event}<span class="rounded-full bg-well px-3 py-1 text-xs"
                  >{eventLabel(event)}</span
                >{/each}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onclick={() => edit(hook)}
                disabled={busy !== null}
                ><Pencil data-icon="inline-start" aria-hidden="true" />{t("common.edit")}</Button
              >
              <!-- Without its table no new changes are captured, but pausing still holds the
                   pending deliveries; only resuming needs the table back (the server refuses it). -->
              {#if hook.enabled || hook.table_available}<Button
                  variant="outline"
                  size="sm"
                  onclick={() => (hook.enabled ? request("pause", hook) : enable(hook))}
                  disabled={busy !== null}
                  >{t(hook.enabled ? "webhooks.pause" : "webhooks.resume")}</Button
                >{/if}
              <Button variant="outline" size="sm" onclick={() => filters(hook.id, "")}
                >{t("webhooks.deliveries")}</Button
              >
            </div>
          </section>
        {/each}
      </div>
      <p class="text-sm text-muted-foreground">
        {t("webhooks.retryGuide")}
        <a
          href={href("/guides/webhooks")}
          class="text-foreground underline underline-offset-4 decoration-muted-foreground/60 hover:decoration-foreground"
          >{t("webhooks.guide")}</a
        >
      </p>
    {/if}
    {#if !(tab === "configuration")}
      {#if history.error}<LoadError
          message={errorMessage(history.error)}
          onretry={loadHistory}
          busy={history.loading}
        />{/if}
      {#if !history.data && history.loading}<Skeleton class="h-48 rounded-3xl" />{/if}
      <DeliveryHistory
        data={history.data}
        endpoints={config.data.endpoints}
        endpoint={endpointFilter}
        status={statusFilter}
        hasCursor={!!before}
        loading={history.loading}
        onfilter={filters}
        onnext={() => filters(endpointFilter, statusFilter, history.data?.next_cursor ?? "")}
        onfirst={() => filters(endpointFilter, statusFilter)}
      />
      <div>
        <Button
          variant="outline"
          onclick={() => request("clear")}
          disabled={busy !== null || !config.data.retained}>{t("webhooks.clear")}</Button
        >
      </div>
    {/if}
    <EndpointDialog
      bind:open={editorOpen}
      endpoint={editing}
      tables={config.data.tables}
      allowLoopback={config.data.allow_loopback}
      onsaved={saved}
    />
  {/if}
</div>
<SecretDialog bind:value={secret} />
<ConfirmDialog
  bind:open={confirmOpen}
  title={t(confirmCopy.title, { name: confirm?.endpoint?.name ?? "" })}
  description={t(confirmCopy.hint)}
  confirmLabel={t(confirmCopy.action)}
  destructive={confirm?.kind === "delete" || confirm?.kind === "clear"}
  onconfirm={apply}
/>
