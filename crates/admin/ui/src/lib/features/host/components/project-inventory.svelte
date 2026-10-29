<script lang="ts">
  import { Button, Input } from "$lib/components/ui";
  import { t } from "$lib/i18n/index.svelte";
  import { hostText as h, label, type Status } from "../model";
  import type { HostConsoleState } from "../console-state.svelte";
  let { model, status }: { model: HostConsoleState; status: Status } = $props();
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    void model.preview({
      kind: "create",
      project: model.name,
      domain: model.domain,
      profile: model.profile,
    });
  }}
  class="grid gap-4 rounded-3xl border border-border bg-card p-6"
  aria-busy={model.busy}
>
  <h3 class="text-lg font-semibold">{h("create")}</h3>
  <p class="text-sm text-muted-foreground">{h("isolation")}</p>
  <div class="grid gap-4 sm:grid-cols-3">
    <div class="grid gap-2">
      <label for="host-name">{h("name")}</label><Input
        id="host-name"
        required
        maxlength={32}
        pattern="[a-z0-9][a-z0-9-]*"
        placeholder="shop"
        bind:value={model.name}
        disabled={model.busy || model.active || model.pending !== null}
      />
    </div>
    <div class="grid gap-2">
      <label for="host-domain">{h("domain")}</label><Input
        id="host-domain"
        required
        maxlength={253}
        placeholder="api.shop.com"
        bind:value={model.domain}
        disabled={model.busy || model.active || model.pending !== null}
      />
    </div>
    <div class="grid gap-2">
      <label for="host-profile">{h("profile")}</label><select
        id="host-profile"
        class="rounded-xl border border-border bg-background p-3"
        bind:value={model.profile}
        disabled={model.busy || model.active || model.pending !== null}
        >{#each ["1gb", "2gb", "4gb", "8gb"] as value}<option {value}>{value}</option
          >{/each}</select
      >
    </div>
  </div>
  <p class="text-sm text-muted-foreground">{h("estimated")}</p>
  <Button
    class="w-fit"
    type="submit"
    disabled={model.busy ||
      model.offline ||
      model.active ||
      model.pending !== null ||
      !status.enabled ||
      status.projects.length >= status.max_projects}>{model.busy ? h("busy") : h("preview")}</Button
  >
</form>
<div class="grid gap-4 sm:grid-cols-2">
  {#each status.projects as item (item.name)}<article
      class="grid gap-4 rounded-3xl border border-border bg-card p-5"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="font-semibold" translate="no">{item.name}</h3>
          <p class="break-all text-sm text-muted-foreground" translate="no">
            {item.domain}
          </p>
        </div>
        <span class="rounded-full bg-well px-3 py-1 text-xs" translate="no"
          >{item.version ? `v${item.version}` : h("unknown")}</span
        >
      </div>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        {#each [[h("app"), item.app], [h("database"), item.database]] as entry}<div>
            <dt class="text-xs text-muted-foreground">{entry[0]}</dt>
            <dd class="mt-1 flex items-center gap-2">
              <span
                class={`size-2 rounded-full ${entry[1] === "healthy" ? "bg-emerald-500" : "bg-amber-500"}`}
                aria-hidden="true"
              ></span>{label(entry[1] ?? "")}
            </dd>
          </div>{/each}
      </dl>
      <div class="flex flex-wrap gap-2">
        <a
          class="rounded-xl border border-border px-3 py-2 text-sm"
          href={`https://${item.domain}/admin/`}
          target="_blank"
          rel="noopener noreferrer"
          >{h("openPanel")}<span class="sr-only"> {t("common.newTab")}</span></a
        ><Button
          size="sm"
          variant="outline"
          disabled={model.busy || model.offline || model.active || model.pending !== null}
          onclick={() => void model.preview({ kind: "backup", project: item.name })}
          >{h("backup")}</Button
        ><Button
          size="sm"
          variant="outline"
          onclick={() => {
            model.selected = item.name;
            model.backup = "";
            model.logReader.logs = null;
          }}>{h("select")}</Button
        >
      </div>
    </article>{/each}
</div>
{#if !status.projects.length}<p class="rounded-2xl bg-card p-6">
    {h("noProjects")}
  </p>{/if}
