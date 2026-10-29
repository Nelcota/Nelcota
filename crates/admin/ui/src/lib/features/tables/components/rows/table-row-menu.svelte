<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";
  import {
    Ellipsis,
    Rows3,
    TableProperties,
    ShieldCheck,
    SquareTerminal,
    Download,
    Copy,
    Pencil,
    Trash,
  } from "@lucide/svelte";

  import { copyText } from "$lib/browser/clipboard";
  import { sqlStore } from "$lib/features/sql/sql-store.svelte";
  import { quoteIfNeeded } from "$lib/shared/schema/ident";
  import { href, navigate } from "$lib/navigation/router.svelte";
  import { enc } from "$lib/transport/api";
  import { t } from "$lib/i18n/index.svelte";

  // Everything a table offers, from the list, without opening it first.
  let { name, view, ondrop }: { name: string; view: boolean; ondrop: () => void } = $props();

  const QUERY_PREVIEW_ROWS = 100;

  function querySql() {
    sqlStore.open(`select *\nfrom ${quoteIfNeeded(name)}\nlimit ${QUERY_PREVIEW_ROWS};`);
    navigate("/sql");
  }

  const exportHref = (format: "csv" | "json") =>
    href(`/api/tables/${enc(name)}/export?format=${format}`);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class="relative"
        aria-label={t("tables.home.actions.label", { table: name })}
        title={t("tables.home.actions.label", { table: name })}
      >
        <Ellipsis aria-hidden="true" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-60">
    <DropdownMenu.Item>
      {#snippet child({ props })}<a {...props} href={href(`/tables/${enc(name)}`)}
          ><Rows3 aria-hidden="true" />{t("tables.home.actions.open")}</a
        >{/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Item>
      {#snippet child({ props })}<a {...props} href={href(`/tables/${enc(name)}/structure`)}
          ><TableProperties aria-hidden="true" />{t("tables.home.actions.structure")}</a
        >{/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Item>
      {#snippet child({ props })}<a
          {...props}
          href={href(`/policies?table=${encodeURIComponent(name)}`)}
          ><ShieldCheck aria-hidden="true" />{t("tables.home.actions.policies")}</a
        >{/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Item onSelect={querySql}
      ><SquareTerminal aria-hidden="true" />{t("tables.home.actions.sql")}</DropdownMenu.Item
    >
    <DropdownMenu.Separator />
    <DropdownMenu.Item>
      {#snippet child({ props })}<a {...props} href={exportHref("csv")} download
          ><Download aria-hidden="true" />{t("tables.home.actions.exportCsv")}</a
        >{/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Item>
      {#snippet child({ props })}<a {...props} href={exportHref("json")} download
          ><Download aria-hidden="true" />{t("tables.home.actions.exportJson")}</a
        >{/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Item onSelect={() => void copyText(name, t("tables.home.actions.nameCopied"))}
      ><Copy aria-hidden="true" />{t("tables.home.actions.copyName")}</DropdownMenu.Item
    >
    {#if view === false}
      <DropdownMenu.Separator />
      <DropdownMenu.Item>
        {#snippet child({ props })}<a
            {...props}
            href={href(`/tables/${enc(name)}/structure?focus=name`)}
            ><Pencil aria-hidden="true" />{t("tables.home.actions.edit")}</a
          >{/snippet}
      </DropdownMenu.Item>
      <DropdownMenu.Item variant="destructive" onSelect={ondrop}
        ><Trash aria-hidden="true" />{t("tables.home.actions.drop")}</DropdownMenu.Item
      >
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
