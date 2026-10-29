<script lang="ts">
  import { navigate, route, pageAfterEmpty, parsePage } from "$lib/navigation";
  import { Users as UsersIcon, Search, UserPlus } from "@lucide/svelte";
  import { dateText } from "$lib/formatting/date";
  import { untrack } from "svelte";
  import { Table, Button, Skeleton, Badge, Tooltip } from "$lib/components/ui";

  import {
    SearchField,
    PageHeader,
    EmptyState,
    LoadError,
    ConfirmDialog,
  } from "$lib/components/shared";

  import { toast } from "svelte-sonner";

  import { CreateUserDialog, SetPasswordDialog, UserActions } from "$lib/features/users/components";

  import { errorMessage, intlLocale, t } from "$lib/i18n/index.svelte";
  import { UserCatalog, type User, signInMethods } from "$lib/features/users/model";

  const resource = new UserCatalog();
  const users = $derived(resource.data?.users ?? null);
  const total = $derived(resource.data?.total ?? 0);
  const page = $derived(parsePage(route.query.get("page")));
  const appliedQuery = $derived(route.query.get("q") ?? "");
  const hasNext = $derived(resource.data?.has_next ?? false);
  let query = $state("");
  const loading = $derived(resource.loading);
  const error = $derived(Boolean(resource.error) === true ? errorMessage(resource.error) : "");

  function go(nextPage: number, nextQuery = appliedQuery, replace = false) {
    const params = new URLSearchParams();
    if (Boolean(nextPage) === true) params.set("page", String(nextPage));
    if (nextQuery !== "") params.set("q", nextQuery);
    navigate(`/users${Boolean(params.size) === true ? `?${params}` : ""}`, replace);
  }
  let target = $state<{ user: User; action: "revoke" | "delete" } | null>(null);
  let confirmOpen = $state(false);
  let createOpen = $state(false);
  let passwordUser = $state<User | null>(null);
  let passwordOpen = $state(false);

  $effect(() => {
    if (route.query.get("create") === "true") {
      createOpen = true;
      const params = new URLSearchParams(route.query);
      params.delete("create");
      navigate(`/users${Boolean(params.size) === true ? `?${params}` : ""}`, true);
    }
  });

  async function load() {
    const params = new URLSearchParams({ page: String(page) });
    if (appliedQuery !== "") params.set("q", appliedQuery);
    await resource.reload(params);
  }

  $effect(() => {
    void [page, appliedQuery];
    void untrack(load);
    return () => resource.cancel();
  });

  // The server lists 50 users per page (crates/admin/src/users/operations.rs).
  const PAGE_SIZE = 50;
  // Deleting the last user of a page past the first, or a stale `page` link,
  // moves to the last page instead of reading "no users yet".
  $effect(() => {
    const data = resource.data;
    if (data == null || loading || data.users.length > 0 || data.page !== page) return;
    const next = pageAfterEmpty({ page: page, size: PAGE_SIZE, total: data.total, exact: true });
    if (next !== null) untrack(() => go(next, appliedQuery, true));
  });

  // Copy the URL into the field only when it says something else (back/forward,
  // a cleared search): rewriting it after a debounce would drop the trailing
  // space the person just typed.
  $effect(() => {
    const applied = appliedQuery;
    untrack(() => {
      if (query.trim() !== applied) query = applied;
    });
  });

  let debounce: ReturnType<typeof setTimeout>;
  function onSearch() {
    const delayInMs = 250;

    clearTimeout(debounce);
    debounce = setTimeout(() => {
      go(0, query.trim(), true);
    }, delayInMs);
  }

  $effect(() => () => clearTimeout(debounce));

  function ask(user: User, action: "revoke" | "delete") {
    target = { user, action };
    confirmOpen = true;
  }

  async function confirmEmail(user: User) {
    try {
      await resource.confirmEmail(user.id);
      toast.success(t("users.emailConfirmed", { email: user.email }));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function confirm() {
    if (target == null) return;
    const { user, action } = target;
    try {
      if (action === "revoke") {
        await resource.revoke(user.id);
        toast.success(t("users.revoked", { email: user.email }));
        await load();
        return;
      }
      await resource.remove(user.id);
      toast.success(t("users.deleted", { email: user.email }));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }

  const date = $derived(
    new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" }),
  );
  const when = (value: string | null) => dateText(value, date.format);
</script>

{#snippet unconfirmed(user: User)}
  {#if !user.email_confirmed_at}
    <!-- Focusable so keyboard users reach the hint, not only mouse hover. -->
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Badge
            {...props}
            variant="outline"
            tabindex={0}
            class="ml-2 cursor-help align-middle font-normal text-muted-foreground"
            >{t("users.unconfirmed")}</Badge
          >
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>{t("users.unconfirmedHint")}</Tooltip.Content>
    </Tooltip.Root>
  {/if}
{/snippet}

{#snippet methods(user: User)}
  {@const list = signInMethods(user)}
  <span
    class="inline-flex flex-wrap gap-1"
    title={list[0]?.kind === "linkOnly" ? t("users.methods.linkOnlyHint") : undefined}
  >
    {#each list as method, i (i)}<span
        class={[
          "rounded-md bg-well px-2 py-0.5 text-xs font-medium",
          method.kind === "linkOnly" ? "text-muted-foreground" : "",
        ]}
        >{#if method.kind === "password"}{t(
            "users.methods.password",
          )}{/if}{#if !(method.kind === "password") && method.kind === "provider"}{method.name}{/if}{#if !(method.kind === "password") && !(method.kind === "provider")}{t(
            "users.methods.linkOnly",
          )}{/if}{#if list[0]?.kind === "linkOnly"}<span class="sr-only"
            >{t("users.methods.linkOnlyHint")}</span
          >{/if}</span
      >{/each}
  </span>
{/snippet}

{#snippet userActions(user: User)}
  <UserActions
    {user}
    onpassword={(next) => {
      passwordUser = next;
      passwordOpen = true;
    }}
    onconfirm={confirmEmail}
    onask={ask}
  />
{/snippet}

<div class="mx-auto w-full max-w-page px-4 pt-2 pb-12 sm:px-6 lg:px-8">
  <PageHeader
    title={t("users.title")}
    description={users
      ? appliedQuery
        ? t("users.matchCount", { count: total, query: appliedQuery })
        : t("users.count", { count: total })
      : t("users.description")}
  >
    {#snippet actions()}
      <Button onclick={() => (createOpen = true)}
        ><UserPlus data-icon="inline-start" aria-hidden="true" />{t("users.new")}</Button
      >
    {/snippet}
  </PageHeader>

  <!-- List toolbar: search on the left, filters beside it; the header keeps only buttons. -->
  <div class="mb-4 flex flex-wrap items-center gap-3">
    <div class="w-full sm:w-72">
      <SearchField
        bind:value={query}
        oninput={onSearch}
        placeholder={t("users.searchPlaceholder")}
        label={t("users.searchLabel")}
      />
    </div>
  </div>

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if users === null}
    {#if loading}<Skeleton class="h-64 rounded-3xl" />{/if}
  {/if}
  {#if !(users === null) && users.length === 0}
    <EmptyState
      class="rounded-3xl bg-card"
      icon={appliedQuery ? Search : UsersIcon}
      title={appliedQuery ? t("users.noResults") : t("users.empty")}
      description={appliedQuery
        ? t("users.noResultsFor", { query: appliedQuery })
        : t("users.emptyDescription")}
    >
      {#snippet actions()}
        {#if appliedQuery}
          <Button
            variant="outline"
            onclick={() => {
              go(0, "");
            }}>{t("users.clearSearch")}</Button
          >
        {/if}
        {#if !appliedQuery}
          <Button variant="outline" onclick={() => (createOpen = true)}
            ><UserPlus data-icon="inline-start" aria-hidden="true" />{t("users.new")}</Button
          >
        {/if}
      {/snippet}
    </EmptyState>
  {/if}
  {#if !(users === null) && !(users.length === 0)}
    <div class="grid gap-3 md:hidden" aria-busy={loading}>
      {#each users as user (user.id)}
        <article class="min-w-0 rounded-3xl bg-card p-4">
          <div class="flex min-w-0 items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="break-all font-medium">{user.email}{@render unconfirmed(user)}</p>
            </div>
            {@render userActions(user)}
          </div>
          <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[0.8125rem]">
            <dt class="text-muted-foreground">{t("users.columns.signIn")}</dt>
            <dd class="text-right">{@render methods(user)}</dd>
            <dt class="text-muted-foreground">{t("users.columns.lastSignIn")}</dt>
            <dd class={["text-right", user.last_sign_in_at ? "" : "text-muted-foreground"]}>
              {user.last_sign_in_at ? when(user.last_sign_in_at) : t("users.neverSignedIn")}
            </dd>
            <dt class="text-muted-foreground">{t("users.columns.created")}</dt>
            <dd class="text-right">{when(user.created_at)}</dd>
            <dt class="text-muted-foreground">{t("users.columns.sessions")}</dt>
            <dd class="text-right tabular-nums">{user.sessions}</dd>
          </dl>
        </article>
      {/each}
    </div>
    <div class="hidden overflow-hidden rounded-3xl bg-card md:block" aria-busy={loading}>
      <Table.Root>
        <Table.Header>
          <Table.Row class="hover:bg-transparent">
            <Table.Head>{t("users.columns.email")}</Table.Head>
            <Table.Head>{t("users.columns.signIn")}</Table.Head>
            <Table.Head>{t("users.columns.created")}</Table.Head>
            <Table.Head>{t("users.columns.lastSignIn")}</Table.Head>
            <Table.Head class="text-right">{t("users.columns.sessions")}</Table.Head>
            <Table.Head class="w-12"><span class="sr-only">{t("common.actions")}</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each users as user (user.id)}
            <Table.Row>
              <Table.Cell>
                <div class="flex items-center gap-3">
                  <span
                    class="grid size-9 shrink-0 place-items-center rounded-full bg-well text-xs font-semibold text-muted-foreground"
                    aria-hidden="true">{user.email.charAt(0).toUpperCase()}</span
                  >
                  <div class="min-w-0">
                    <p class="font-medium">{user.email}{@render unconfirmed(user)}</p>
                  </div>
                </div>
              </Table.Cell>
              <Table.Cell>{@render methods(user)}</Table.Cell>
              <!-- Dates stay secondary to the email; no sessions reads as muted, like "never". -->
              <Table.Cell class="text-muted-foreground tabular-nums"
                >{when(user.created_at)}</Table.Cell
              >
              <Table.Cell class="text-muted-foreground tabular-nums"
                >{user.last_sign_in_at
                  ? when(user.last_sign_in_at)
                  : t("users.neverSignedIn")}</Table.Cell
              >
              <Table.Cell
                class={["text-right tabular-nums", user.sessions ? "" : "text-muted-foreground"]}
                >{user.sessions}</Table.Cell
              >
              <Table.Cell class="text-right">
                {@render userActions(user)}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}

  {#if page > 0 || hasNext}
    <nav class="mt-4 flex items-center justify-end gap-2" aria-label={t("users.pagination")}>
      <span class="mr-1 text-sm text-muted-foreground">{t("common.page", { page: page + 1 })}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || page === 0}
        onclick={() => go(page - 1)}>{t("common.previous")}</Button
      >
      <Button
        variant="outline"
        size="sm"
        disabled={loading || !hasNext}
        onclick={() => go(page + 1)}>{t("common.next")}</Button
      >
    </nav>
  {/if}
</div>

<CreateUserDialog bind:open={createOpen} oncreated={load} />
{#if passwordUser}
  <SetPasswordDialog bind:open={passwordOpen} user={passwordUser} onsaved={load} />
{/if}

{#if target}
  <ConfirmDialog
    bind:open={confirmOpen}
    title={target.action === "revoke"
      ? t("users.confirmRevoke.title")
      : t("users.confirmDelete.title")}
    description={target.action === "revoke"
      ? t("users.confirmRevoke.description", { email: target.user.email })
      : t("users.confirmDelete.description", { email: target.user.email })}
    confirmLabel={target.action === "revoke" ? t("users.revokeSessions") : t("common.delete")}
    destructive={target.action === "delete"}
    onconfirm={confirm}
  />
{/if}
