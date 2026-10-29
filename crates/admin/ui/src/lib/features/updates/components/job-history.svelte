<script lang="ts">
  import { RotateCcwClock as History } from "@lucide/svelte";
  import { Button } from "$lib/components/ui";
  import { progress } from "../presentation";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  import type { Status } from "../controller";
  let { model, status }: { model: UpdatesConsoleState; status: Status } = $props();
</script>

<section class="history-section" aria-labelledby="history-title">
  <div class="section-heading">
    <h2 id="history-title">
      <History class="size-4" aria-hidden="true" />{t("updates.history")}
    </h2>
    <span class="history-count">{status.jobs.length}</span>
  </div>
  {#if status.jobs.length === 0}<div class="history-empty">
      <span><History class="size-5" aria-hidden="true" /></span>
      <h3>{t("updates.emptyHistory")}</h3>
      <p>{t("updates.emptyHistoryHint")}</p>
    </div>{/if}
  {#each status.jobs as job (job.id)}
    <article class="job-card">
      <div class="job-heading">
        <p translate="no">{job.project}<span>{job.current} → {job.target}</span></p>
        <span
          class="job-phase"
          class:job-success={job.phase === "succeeded" || job.phase === "recovered"}
          class:job-warning={job.phase === "needs_operator" || job.phase === "failed_before_change"}
          role="status">{t(`updates.${job.phase}`)}</span
        >
      </div>
      {#if progress[job.phase] !== undefined}<progress
          max="7"
          value={progress[job.phase]}
          aria-label={t(`updates.${job.phase}`)}
        ></progress>{/if}
      <p class="job-id" translate="no">{job.id}</p>
      {#if job.phase === "needs_operator"}<Button
          class="w-fit"
          variant="outline"
          disabled={model.busy || model.offline}
          onclick={() => {
            model.clearApproval();
            model.recover = job;
          }}>{t("updates.recover")}</Button
        >{/if}
    </article>
  {/each}
</section>

<style>
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .section-heading h2 {
    display: flex;
    gap: 0.625rem;
    align-items: center;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .section-heading h2 :global(svg) {
    color: var(--muted-foreground);
  }

  .history-count {
    font-size: 0.6875rem;
    border: 1px solid var(--border-strong);
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    color: var(--muted-foreground);
  }
  .history-section {
    display: grid;
    gap: 1rem;
  }
  .history-empty {
    border: 1px dashed var(--border-strong);
    border-radius: 0.875rem;
    padding: 2.5rem 1rem;
    text-align: center;
  }
  .history-empty > span {
    display: inline-flex;
    padding: 0.75rem;
    border-radius: 0.75rem;
    background: var(--well);
    color: var(--muted-foreground);
    margin-bottom: 1rem;
  }
  .history-empty h3 {
    font-size: 0.875rem;
    font-weight: 500;
  }
  .history-empty p {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    margin-top: 0.5rem;
  }
  .job-card {
    padding: 1.25rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    display: grid;
    gap: 0.875rem;
  }
  .job-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .job-heading p {
    font-weight: 600;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .job-heading p span {
    display: block;
    color: var(--muted-foreground);
    font: 400 0.75rem var(--font-mono);
    margin-top: 0.375rem;
  }
  .job-phase {
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    background: var(--well);
    font-size: 0.75rem;
  }
  .job-success {
    color: var(--success);
  }
  .job-warning {
    color: var(--warning);
  }
  .job-id {
    font: 0.6875rem var(--font-mono);
    color: var(--muted-foreground);
    overflow-wrap: anywhere;
  }
  progress {
    appearance: none;
    width: 100%;
    height: 0.25rem;
    border: 0;
    border-radius: 1rem;
    overflow: hidden;
    background: var(--well);
    accent-color: var(--brand);
  }
  progress::-webkit-progress-bar {
    background: var(--well);
  }
  progress::-webkit-progress-value {
    background: var(--brand);
  }
  progress::-moz-progress-bar {
    background: var(--brand);
  }
</style>
