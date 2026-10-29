<script lang="ts">
  import { onMount } from "svelte";
  import { ProjectInventory, ProjectActions, ApprovalForm, JobHistory } from "./components";
  import UnsavedChangesDialog from "$lib/components/shared/dialogs/unsaved-changes-dialog.svelte";
  import { Health, Alerts, Settings } from "../server/components";
  import { Button } from "$lib/components/ui";
  import { t, i18n } from "$lib/i18n/index.svelte";
  import { formatGibibytes } from "../storage/files";
  import { hostText as h, serverText, terminal, type HostArea } from "./model";
  import { HostConsoleState } from "./console-state.svelte";
  let {
    email,
    expired,
    area = $bindable<HostArea>("projects"),
  }: { email: string; expired: () => void; area?: HostArea } = $props();
  const model = new HostConsoleState({ email: () => email, expired: () => expired() });
  const size = (bytes: number) => formatGibibytes(bytes, i18n.locale);
  onMount(model.mount);
  export function selectArea(next: HostArea): void {
    model.leave(() => {
      area = next;
    });
  }
  export function navigationBusy(): boolean {
    return model.busy;
  }
  export function leave(proceed: () => void): void {
    model.leave(proceed);
  }
</script>

<svelte:window ononline={() => void model.refresh()} onfocus={() => void model.refresh()} />
<section class="grid gap-6" aria-labelledby="host-title">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 id="host-title" class="text-2xl font-semibold">{serverText("title")}</h2>
      <p class="mt-2 text-sm text-muted-foreground">{serverText("description")}</p>
    </div>
    <Button
      variant="outline"
      disabled={model.busy || model.polling}
      onclick={() => void model.refresh()}>{h("refresh")}</Button
    >
  </header>
  {#if model.failure}<div
      class="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
      role="alert"
    >
      {model.failure}
    </div>{/if}
  {#if model.notice}<div
      class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
      role="status"
    >
      {model.notice}
    </div>{/if}
  {#if model.offline}<p class="rounded-2xl bg-well p-4 text-sm" role="status">
      {h("offline")}
    </p>{/if}
  {#if !model.status}<p role="status">{t("shell.app.loading")}</p>{/if}
  {#if model.status}
    {#if model.status.projects.length}<label class="grid gap-2"
        ><span class="text-sm font-medium">{serverText("project")}</span><select
          class="rounded-xl border border-border bg-card p-3"
          value={model.selected}
          disabled={model.busy}
          onchange={(event) => {
            const value = event.currentTarget.value;
            event.currentTarget.value = model.selected;
            model.leave(() => {
              model.selected = value;
              model.backup = "";
              model.logReader.logs = null;
            });
          }}
          >{#each model.status.projects as p}<option value={p.name}>{p.name} · {p.domain}</option
            >{/each}</select
        ></label
      >{/if}
    <dl class="grid gap-3 sm:grid-cols-3">
      {#each [[h("count"), `${model.status.projects.length} / ${model.status.max_projects}`], [h("ram"), size(model.status.ram_mb * 1024 ** 2)], [h("disk"), size(model.status.free_bytes)]] as item}<div
          class="rounded-2xl border border-border bg-card p-5"
        >
          <dt class="text-xs text-muted-foreground">{item[0]}</dt>
          <dd class="mt-2 text-2xl font-semibold">{item[1]}</dd>
        </div>{/each}
    </dl>
    {#if model.status.busy}<p class="rounded-2xl bg-well p-4 text-sm" role="status">
        {h("host_busy")}
      </p>{/if}{#if !model.status.enabled}<p role="status">{h("readOnly")}</p>{/if}
    {#if area === "projects"}<ProjectInventory {model} status={model.status} />
    {/if}
    {#if model.project && area === "alerts"}{#key model.project.name}<Alerts
          project={model.project.name}
          disabled={model.busy ||
            model.offline ||
            model.active ||
            model.pending !== null ||
            model.plan !== null ||
            model.recovery !== null}
          revision={model.status.jobs
            .filter((job) => terminal(job.stage))
            .map((job) => `${job.id}:${job.sequence}`)
            .join("|")}
          prepare={(configuration) => model.preview(null, configuration)}
          action={(operation) => model.preview(operation)}
          expired={model.expired}
          ondirty={(value) => {
            model.dirty = value;
          }}
          navigate={model.leave}
        />{/key}{/if}
    {#if model.project && area === "health"}{#key model.project.name}<Health
          project={model.project.name}
          expired={model.expired}
        />{/key}{/if}
    {#if model.project && (area === "settings" || area === "backups")}{#key `${model.project.name}:${area}`}<Settings
          project={model.project.name}
          domain={model.project.domain}
          backups={area === "backups"}
          disabled={model.busy ||
            model.offline ||
            model.active ||
            model.pending !== null ||
            model.plan !== null ||
            model.recovery !== null}
          revision={model.status.jobs
            .filter((job) => terminal(job.stage))
            .map((job) => `${job.id}:${job.sequence}`)
            .join("|")}
          prepare={(configuration) => model.preview(null, configuration)}
          action={(operation) => model.preview(operation)}
          expired={model.expired}
          ondirty={(value) => {
            model.dirty = value;
          }}
          navigate={model.leave}
        />{/key}{/if}
    {#if model.project && area === "settings"}{@const project = model.project}
      <div class="grid gap-3 rounded-3xl bg-card p-6">
        <p class="text-sm text-muted-foreground">{serverText("restartImpact")}</p>
        <Button
          class="w-fit"
          variant="outline"
          disabled={model.busy ||
            model.offline ||
            model.active ||
            model.pending !== null ||
            model.plan !== null ||
            model.recovery !== null ||
            model.dirty}
          onclick={() => void model.preview({ kind: "restart", project: project.name })}
          >{serverText("restart")}</Button
        >
      </div>{/if}
    {#if model.project && (area === "projects" || area === "backups")}<ProjectActions
        {model}
        project={model.project}
      />{/if}
    <ApprovalForm {model} />
    <JobHistory {model} status={model.status} />
  {/if}
</section>

<UnsavedChangesDialog bind:open={model.guard.pending} ondiscard={model.guard.discard} />
