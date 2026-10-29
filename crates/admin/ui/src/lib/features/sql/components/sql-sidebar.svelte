<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import {
    Ellipsis,
    Plus,
    FileCode,
    FilePen,
    BookOpen,
    Pencil,
    Trash as Trash2,
  } from "@lucide/svelte";

  import { SQL_SNIPPETS } from "$lib/features/sql/sql-snippets";
  import { sqlStore, type SavedQuery, type SqlDraft } from "$lib/features/sql/sql-store.svelte";
  import { draftName } from "$lib/features/sql/query-name";
  import { cn } from "$lib/components/component-props";
  import { t } from "$lib/i18n/index.svelte";

  let {
    onrename,
    ondelete,
    ondeleteDraft,
  }: {
    onrename: (query: SavedQuery) => void;
    ondelete: (query: SavedQuery) => void;
    ondeleteDraft: (draft: SqlDraft) => void;
  } = $props();

  const item =
    "group flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground";
  const heading = "px-2.5 pb-1 text-xs font-medium text-muted-foreground";
  // With nothing saved yet, the templates are the most useful thing here.
  const templatesFirst = $derived(sqlStore.saved.length === 0);
</script>

{#snippet templates(first: boolean)}
  <p class={cn(heading, !first && "mt-6")}>{t("sql.editor.templates")}</p>
  <div class="grid gap-0.5">
    {#each SQL_SNIPPETS as snippet (snippet.label)}
      <button class={item} title={t(snippet.label)} onclick={() => sqlStore.open(t(snippet.sql))}>
        <BookOpen class="size-4 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{t(snippet.label)}</span>
      </button>
    {/each}
  </div>
{/snippet}

<aside
  class="hidden shrink-0 flex-col overflow-hidden rounded-3xl bg-card lg:flex lg:w-64 xl:w-72"
  aria-label={t("sql.sidebar.label")}
>
  <div class="flex h-14 shrink-0 items-center justify-between border-b pr-2 pl-5">
    <p class="text-sm font-semibold">{t("sql.sidebar.title")}</p>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={() => sqlStore.open("")}
      title={t("sql.editor.newQuery")}
      aria-label={t("sql.editor.newQuery")}
    >
      <Plus />
    </Button>
  </div>

  <!-- Long names are cut with an ellipsis and shown whole on hover: no sideways scroll. -->
  <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
    {#if templatesFirst}{@render templates(true)}{/if}

    {#if sqlStore.saved.length}
      <p class={heading}>{t("sql.sidebar.savedCount", { count: sqlStore.saved.length })}</p>
      <div class="grid gap-0.5">
        {#each sqlStore.sorted as query (query.id)}
          {@const active = query.id === sqlStore.currentId}
          <div class={cn(item, "pr-1", active && "bg-sidebar-accent font-medium text-foreground")}>
            <button
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2"
              aria-current={active ? "true" : undefined}
              title={query.name}
              onclick={() => sqlStore.openSaved(query.id)}
            >
              <FileCode class="size-4 shrink-0" aria-hidden="true" />
              <span class="truncate">{query.name}</span>
              {#if active && sqlStore.dirty}<span
                  class="size-1.5 shrink-0 rounded-full bg-muted-foreground"
                  title={t("sql.editor.unsavedTitle")}
                ></span>{/if}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md opacity-100 hover:bg-accent"
                    aria-label={t("sql.sidebar.actionsFor", { name: query.name })}
                  >
                    <Ellipsis class="size-4" />
                  </button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="w-44">
                <DropdownMenu.Group
                  ><DropdownMenu.Item onclick={() => onrename(query)}
                    ><Pencil aria-hidden="true" />{t("sql.sidebar.rename")}</DropdownMenu.Item
                  ></DropdownMenu.Group
                >
                <DropdownMenu.Separator />
                <DropdownMenu.Group
                  ><DropdownMenu.Item variant="destructive" onclick={() => ondelete(query)}
                    ><Trash2 aria-hidden="true" />{t("common.delete")}</DropdownMenu.Item
                  ></DropdownMenu.Group
                >
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        {/each}
      </div>
    {/if}

    {#if sqlStore.looseDrafts.length}
      <p class={cn(heading, (sqlStore.saved.length || templatesFirst) && "mt-6")}>
        {t("sql.editor.drafts")}
      </p>
      <div class="grid gap-0.5">
        {#each sqlStore.looseDrafts as draft (draft.id)}
          {@const active = sqlStore.activeDraftId === draft.id}
          <div class={cn(item, "pr-1", active && "bg-sidebar-accent text-foreground")}>
            <button
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2"
              onclick={() => sqlStore.openDraft(draft.id)}
              aria-current={active ? "true" : undefined}
              title={draft.sql.trim().split("\n")[0]}
              ><FilePen class="size-4 shrink-0" aria-hidden="true" /><span class="truncate"
                >{draftName(draft.sql)}</span
              ></button
            >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("sql.sidebar.discardDraft", { name: draftName(draft.sql) })}
              title={t("common.discard")}
              onclick={() => ondeleteDraft(draft)}><Trash2 aria-hidden="true" /></Button
            >
          </div>
        {/each}
      </div>
    {/if}

    {#if !templatesFirst}{@render templates(false)}{/if}
  </div>

  <p
    class="shrink-0 border-t px-4 py-2.5 text-xs text-muted-foreground"
    title={t("sql.editor.localOnly")}
  >
    {t("sql.sidebar.localOnly")}
  </p>
</aside>
