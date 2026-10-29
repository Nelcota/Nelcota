<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import {
    ArrowUp,
    ArrowDown,
    ArrowUpDown,
    ChevronDown,
    KeyRound,
    Funnel,
    Copy,
    EyeOff,
    X,
  } from "@lucide/svelte";

  import { copyText } from "$lib/browser/clipboard";
  import { alignRight, type ColumnKind } from "$lib/features/tables/rows/grid";
  import type { Column } from "$lib/contracts/types";
  import { t } from "$lib/i18n/index.svelte";

  let {
    column,
    kind,
    sort,
    onsort,
    onsortset,
    onfilter,
    onhide,
  }: {
    column: Column;
    kind: ColumnKind;
    /** `asc`/`desc` when the grid is sorted by this column. */
    sort: "asc" | "desc" | null;
    /** Click on the name: cycles ascending → descending → unsorted. */
    onsort: () => void;
    onsortset: (direction: "asc" | "desc" | null) => void;
    onfilter: () => void;
    onhide: () => void;
  } = $props();

  const sortLabel = $derived.by(() => {
    if (sort === "asc") return t("tables.header.sortedAsc");
    return sort === "desc" ? t("tables.header.sortedDesc") : t("tables.header.unsorted");
  });

  // Actions that reload the grid run only after the menu finishes closing:
  // re-rendering the header mid-animation made bits-ui skip its cleanup and
  // left `pointer-events: none` on the body (frozen page).
  let pending: (() => void) | null = null;
  const afterClose = (action: () => void) => () => (pending = action);

  function onOpenChangeComplete(open: boolean) {
    if (open || pending == null) return;
    const action = pending;
    pending = null;
    action();
  }

  async function copyName() {
    await copyText(column.name, t("tables.toast.nameCopied", { name: column.name }));
  }
</script>

<div class="group/head flex h-full items-stretch">
  <button
    type="button"
    class={[
      "flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 py-2.5 pl-3.5 text-left transition-colors hover:bg-accent/70",
      alignRight(kind) && "flex-row-reverse text-right",
    ]}
    onclick={onsort}
    title={column.comment ?? undefined}
    aria-label={t("tables.header.label", {
      name: column.name,
      type: column.full_type,
      sort: sortLabel,
    })}
  >
    <span class="grid min-w-0 flex-1">
      <span
        class={[
          "flex items-center gap-1.5 truncate text-[0.8125rem] font-medium text-foreground",
          alignRight(kind) && "justify-end",
        ]}
      >
        {#if column.is_pk}<KeyRound
            class="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />{/if}
        <span class="truncate">{column.name}</span>
      </span>
      <span class="mt-0.5 truncate font-mono text-3xs font-normal text-muted-foreground"
        >{column.full_type}{#if column.references}<span class="text-brand"
            >{` → ${column.references.table}`}</span
          >{/if}</span
      >
    </span>
    <!-- Sort indicator: subtle until hover; highlighted when active. -->
    <span class="mt-0.5 shrink-0" aria-hidden="true">
      {#if sort === "asc"}<ArrowUp class="size-3.5 text-brand" />
      {/if}
      {#if !(sort === "asc") && sort === "desc"}<ArrowDown class="size-3.5 text-brand" />
      {/if}
      {#if !(sort === "asc") && !(sort === "desc")}<ArrowUpDown
          class="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/head:opacity-100"
        />{/if}
    </span>
  </button>
  <DropdownMenu.Root {onOpenChangeComplete}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="grid w-7 shrink-0 cursor-pointer place-items-center text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 aria-expanded:bg-accent aria-expanded:opacity-100 md:opacity-0 md:group-hover/head:opacity-100"
          aria-label={t("tables.header.options", { name: column.name })}
        >
          <ChevronDown class="size-3.5" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-56">
      <DropdownMenu.Label class="truncate font-mono text-xs font-normal text-muted-foreground"
        >{column.name}</DropdownMenu.Label
      >
      <DropdownMenu.Item onclick={afterClose(() => onsortset("asc"))} disabled={sort === "asc"}
        ><ArrowUp />{t("tables.header.sortAscending")}</DropdownMenu.Item
      >
      <DropdownMenu.Item onclick={afterClose(() => onsortset("desc"))} disabled={sort === "desc"}
        ><ArrowDown />{t("tables.header.sortDescending")}</DropdownMenu.Item
      >
      {#if sort}<DropdownMenu.Item onclick={afterClose(() => onsortset(null))}
          ><X />{t("tables.header.clearSort")}</DropdownMenu.Item
        >{/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={afterClose(onfilter)}
        ><Funnel />{t("tables.header.filterBy")}</DropdownMenu.Item
      >
      <DropdownMenu.Item onclick={copyName}><Copy />{t("tables.header.copyName")}</DropdownMenu.Item
      >
      <DropdownMenu.Item onclick={afterClose(onhide)}
        ><EyeOff />{t("tables.header.hide")}</DropdownMenu.Item
      >
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
