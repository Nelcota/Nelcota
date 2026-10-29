<script lang="ts">
  import { Button } from "$lib/components/ui";
  import { hostText as h, type Status } from "../model";
  import type { HostConsoleState } from "../console-state.svelte";
  let { model, project }: { model: HostConsoleState; project: Status["projects"][number] } =
    $props();
</script>

<section class="grid gap-4 rounded-3xl border border-border bg-card p-6">
  <h3 class="text-lg font-semibold" translate="no">{project.name}</h3>
  <label for="host-backup">{h("backupFile")}</label><select
    id="host-backup"
    class="rounded-xl border border-border bg-background p-3"
    bind:value={model.backup}
    disabled={model.busy || model.active || model.pending !== null}
    ><option value="">{h("selectBackup")}</option>{#each project.backups as file}<option
        value={file}>{file}</option
      >{/each}</select
  >
  <div class="flex flex-wrap gap-3">
    <Button
      variant="outline"
      disabled={!model.backup ||
        model.busy ||
        model.offline ||
        model.active ||
        model.pending !== null}
      onclick={() =>
        void model.preview({ kind: "restore", project: project.name, backup: model.backup })}
      >{h("restore")}</Button
    ><Button
      variant="destructive"
      disabled={model.busy || model.offline || model.active || model.pending !== null}
      onclick={() => void model.preview({ kind: "remove", project: project.name })}
      >{h("remove")}</Button
    >
  </div>
  <div class="grid gap-2">
    <label for="host-log-service">{h("logService")}</label><select
      id="host-log-service"
      class="rounded-xl border border-border bg-background p-3"
      bind:value={model.logReader.service}
      onchange={() => {
        model.logReader.logs = null;
      }}
      ><option value="app">{h("app")}</option><option value="database">{h("database")}</option
      ></select
    ><Button
      class="w-fit"
      variant="outline"
      disabled={model.busy || model.offline}
      onclick={() => void model.logReader.read()}>{h("logs")}</Button
    >
  </div>
  <p class="text-sm text-muted-foreground">{h("logPrivacy")}</p>
  {#if model.logReader.logs}<div
      class="max-h-72 overflow-auto rounded-xl bg-well p-3 text-[0.8125rem]"
      role="log"
      aria-label={h("logs")}
    >
      {#if !model.logReader.logs.length}<p>
          {h("noLogs")}
        </p>{/if}{#each model.logReader.logs as line}<p class="break-all font-mono" translate="no">
          {line.timestamp}
          {line.level}
          {line.target} <span translate="yes">{h("metadata")}</span>
        </p>{/each}
    </div>{/if}
</section>
