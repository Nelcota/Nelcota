<script lang="ts">
  import { Button } from "$lib/components/ui";
  import { t, i18n } from "$lib/i18n/index.svelte";
  import { dateTimeText } from "$lib/formatting/date";
  import { hostText as h, label, steps, type Status } from "../model";
  import type { HostConsoleState } from "../console-state.svelte";
  let { model, status }: { model: HostConsoleState; status: Status } = $props();
</script>

<section class="grid gap-4" aria-labelledby="host-history">
  <h3 id="host-history" class="text-lg font-semibold">{h("history")}</h3>
  {#if !status.jobs.length}<p class="text-sm text-muted-foreground">
      {h("noHistory")}
    </p>{/if}{#each status.jobs as job (job.id)}<article
      class={`grid gap-4 rounded-3xl border bg-card p-5 ${job.stage === "completed" ? "border-emerald-500/30" : job.stage === "needs_attention" || job.stage === "failed" ? "border-amber-500/40" : "border-border"}`}
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="font-semibold" translate="no">
          {job.operation.project}
          <span class="text-sm font-normal text-muted-foreground" translate="yes"
            >· {h(job.operation.kind)}</span
          >
        </p>
        <span class="rounded-full bg-well px-3 py-1 text-xs" role="status">{label(job.stage)}</span>
      </div>
      <ol class="flex flex-wrap gap-2 text-xs" aria-label={h("progress")}>
        {#each steps(job.operation) as stage, index}<li
            class={`rounded-lg px-3 py-2 ${job.stage === stage || job.stage === "completed" ? "bg-primary/10 text-brand" : "bg-well text-muted-foreground"}`}
            aria-current={job.stage === stage ? "step" : undefined}
          >
            {index + 1} · {label(stage)}
          </li>{/each}
      </ol>
      {#if job.last_stage}<p class="text-sm">
          {h("lastStage")}: {label(job.last_stage)}
        </p>{/if}{#if job.error}<p class="text-sm">
          {label(job.error)}
        </p>{/if}{#if job.backup}<p class="break-all text-[0.8125rem]">
          {h("backupSaved")}: <span translate="no">{job.backup}</span>
        </p>{/if}
      <details class="text-[0.8125rem] text-muted-foreground">
        <summary>{h("result")}</summary>
        <p class="mt-2 break-all font-mono" translate="no">{job.id}</p>
        <p>{dateTimeText(job.updated_at * 1000, i18n.locale)}</p>
      </details>
      {#if job.stage === "needs_attention"}<p class="text-sm">
          {h("recovery")}
        </p>
        <Button
          class="w-fit"
          variant="outline"
          disabled={model.busy || model.offline || model.pending !== null}
          onclick={() => model.recover(job)}>{h("resume")}</Button
        >{/if}{#if job.stage === "completed" && job.operation.kind === "create"}<a
          class="w-fit text-sm underline"
          href={`https://${job.operation.domain}/admin/`}
          target="_blank"
          rel="noopener noreferrer"
          >{h("openPanel")}<span class="sr-only"> {t("common.newTab")}</span></a
        >{/if}
    </article>{/each}
</section>
