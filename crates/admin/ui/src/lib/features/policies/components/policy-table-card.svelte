<script lang="ts">
  import { Plus, Pencil, Trash as Trash2, ShieldCheck, LoaderCircle } from "@lucide/svelte";

  import { Button } from "$lib/components/ui/button";
  import CodeBlock from "$lib/components/shared/code-block.svelte";
  import RlsBadge from "$lib/shared/schema/components/rls-badge.svelte";
  import { technical } from "$lib/shared/schema/technical.svelte";
  import { describePolicy, type PolicyMeaning } from "$lib/shared/schema/plain";
  import { toPolicyDef, type PolicyDef } from "$lib/shared/schema/ddl";
  import { href } from "$lib/navigation/router.svelte";
  import { isOwnerView, type PolicyTable } from "$lib/features/policies/attention";
  import { t } from "$lib/i18n/index.svelte";

  let {
    table,
    enabling,
    onenable,
    oncreate,
    onedit,
    ondelete,
  }: {
    table: PolicyTable;
    enabling: string | null;
    onenable: () => void;
    oncreate: () => void;
    onedit: (policy: PolicyDef) => void;
    ondelete: (policy: string) => void;
  } = $props();

  // Collapse long expressions to keep neighboring rules visible.
  const LONG_EXPRESSION = 160;

  /** Describe standard rules; label custom rules and show their SQL. */
  function sentence(meaning: PolicyMeaning): string {
    switch (meaning.kind) {
      case "everyoneReads":
      case "signedInReads":
        return t(`policies.plain.rule.${meaning.kind}`);
      case "owner":
        return t(`policies.plain.rule.owner.${meaning.command}`);
      case "custom":
        return t("policies.plain.rule.custom");
    }
  }
</script>

<section
  class="grid gap-4 rounded-3xl bg-card p-5 sm:p-6"
  aria-labelledby={`policy-table-${table.name}`}
>
  <header class="flex flex-wrap items-center gap-x-4 gap-y-3">
    <div class="grid min-w-0 flex-1 basis-56 gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <h3
          id={`policy-table-${table.name}`}
          class="text-lg font-semibold [overflow-wrap:anywhere]"
        >
          <a href={href(`/tables/${encodeURIComponent(table.name)}`)} class="hover:underline"
            >{table.name}</a
          >
        </h3>
        <RlsBadge rls={table.rls} />
      </div>
      <p class="text-sm text-muted-foreground">
        {t("policies.count", { count: table.policies.length })}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if table.rls.enabled === false && isOwnerView(table) === false}
        <Button variant="outline" size="sm" disabled={enabling !== null} onclick={onenable}>
          {#if enabling === table.name}<LoaderCircle
              data-icon="inline-start"
              class="animate-spin"
              aria-hidden="true"
            />{/if}
          {#if enabling !== table.name}<ShieldCheck
              data-icon="inline-start"
              aria-hidden="true"
            />{/if}
          {t("policies.enableRls")}
        </Button>
      {/if}
      <Button variant="outline" size="sm" onclick={oncreate}
        ><Plus data-icon="inline-start" aria-hidden="true" />{t("policies.newPolicy")}</Button
      >
    </div>
  </header>

  {#if table.policies.length === 0}
    <p class="border-t pt-4 text-sm text-muted-foreground">
      {#if table.rls.enabled}
        {t("policies.noPoliciesRlsBefore")}
        <code class="text-[0.8125rem] text-foreground">service_role</code>
        {t("policies.noPoliciesRlsAfter")}
      {/if}
      {#if table.rls.enabled === false}{t("policies.noPolicies")}{/if}
    </p>
  {/if}

  {#if table.policies.length > 0}
    <ul class="grid divide-y border-t">
      {#each table.policies as policy (policy.name)}
        {@const meaning = describePolicy(policy)}
        {@const showSql = technical.on || meaning.kind === "custom"}
        {@const def = toPolicyDef(policy)}
        <li class="flex items-start gap-3 py-3.5 last:pb-0">
          <div class="grid min-w-0 flex-1 gap-1">
            <p class="text-base font-medium [overflow-wrap:anywhere]">
              {sentence(meaning)}
              {#if policy.permissive === false}<span
                  class="ml-1 text-sm font-normal text-muted-foreground"
                  >{t("policies.restrictiveTag")}</span
                >{/if}
            </p>
            <p class="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              <span class="font-mono">{policy.name}</span>{#if meaning.kind === "owner"}<span
                  class="px-1.5"
                  aria-hidden="true">·</span
                >{t("policies.plain.rule.ownerColumn", { column: meaning.column })}{/if}
            </p>
            {#if showSql}
              <div
                class="mt-1 grid min-w-0 gap-1 rounded-xl bg-well px-3 py-2 font-mono text-[0.8125rem]"
              >
                <p class="text-muted-foreground">
                  <span class="text-foreground">{policy.command}</span> · {policy.roles.join(", ")}
                </p>
                {#if policy.using}
                  {#if policy.using.length > LONG_EXPRESSION}<details>
                      <summary class="cursor-pointer text-muted-foreground"
                        >USING · {t("common.details")}</summary
                      ><CodeBlock code={policy.using} lang="sql" wrap />
                    </details>{/if}
                  {#if policy.using.length <= LONG_EXPRESSION}<p class="[overflow-wrap:anywhere]">
                      <span class="text-muted-foreground">using</span>
                      {policy.using}
                    </p>{/if}
                {/if}
                {#if policy.check}
                  {#if policy.check.length > LONG_EXPRESSION}<details>
                      <summary class="cursor-pointer text-muted-foreground"
                        >WITH CHECK · {t("common.details")}</summary
                      ><CodeBlock code={policy.check} lang="sql" wrap />
                    </details>{/if}
                  {#if policy.check.length <= LONG_EXPRESSION}<p class="[overflow-wrap:anywhere]">
                      <span class="text-muted-foreground">with check</span>
                      {policy.check}
                    </p>{/if}
                {/if}
              </div>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("policies.editLabel", { name: policy.name })}
              title={def ? t("common.edit") : t("policies.customRoles")}
              aria-disabled={def == null}
              aria-describedby={def ? undefined : `custom-roles-${table.name}-${policy.name}`}
              class={def ? undefined : "cursor-not-allowed opacity-50"}
              onclick={() => {
                if (def) onedit(def);
              }}><Pencil /></Button
            >
            {#if def == null}<span id={`custom-roles-${table.name}-${policy.name}`} class="sr-only"
                >{t("policies.customRoles")}</span
              >{/if}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("policies.deleteLabel", { name: policy.name })}
              title={t("common.delete")}
              onclick={() => ondelete(policy.name)}><Trash2 /></Button
            >
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
