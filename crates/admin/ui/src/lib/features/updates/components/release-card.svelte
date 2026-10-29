<script lang="ts">
  import {
    ArrowRight,
    Server,
    RefreshCw,
    CircleAlert,
    CircleCheck,
    Download,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui";
  import { blocker } from "../presentation";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  import type { Status } from "../controller";
  let { model, status }: { model: UpdatesConsoleState; status: Status } = $props();
</script>

<section class="release-card" aria-labelledby="release-title">
  <div class="section-heading">
    <h2 id="release-title">
      <Download class="size-4" aria-hidden="true" />{t("updates.releaseTitle")}
    </h2>
    <span class="release-channel">{t("updates.officialChannel")}</span>
  </div>
  <div class="project-field">
    <label for="update-project">{t("updates.project")}</label>
    <div class="select-wrap">
      <Server class="size-4" aria-hidden="true" /><select
        id="update-project"
        bind:value={model.project}
        disabled={model.busy || model.active}
        onchange={model.clearApproval}
        ><option value="" disabled>{t("updates.select")}</option
        >{#each status.projects as item (item.name)}<option value={item.name}>{item.name}</option
          >{/each}</select
      >
    </div>
  </div>
  <dl class="version-comparison">
    <div>
      <dt>{t("updates.current")}</dt>
      <dd translate="no">{model.selected?.version ?? "—"}</dd>
    </div>
    <ArrowRight class="version-arrow size-5" aria-hidden="true" />
    <div>
      <dt>{t("updates.available")}</dt>
      <dd class:version-available={model.selected?.update_available} translate="no">
        {status.release?.version ?? "—"}
      </dd>
    </div>
  </dl>
  <div class="release-status" aria-live="polite">
    {#if status.checking}<p>
        <RefreshCw class="size-4 motion-safe:animate-spin" aria-hidden="true" />{t(
          "updates.checking",
        )}
      </p>{/if}
    {#if status.check_error}<p role="alert" class="text-warning">
        <CircleAlert class="size-4 shrink-0" aria-hidden="true" />{blocker(status.check_error)}
      </p>{/if}
    {#if status.release && model.selected && !model.selected.update_available}<p>
        <CircleCheck class="size-4 shrink-0" aria-hidden="true" />{t("updates.noUpdate")}
      </p>{/if}
    {#if !status.release && !status.checking && !status.check_error}<p>
        {t("updates.noRelease")}
      </p>{/if}
  </div>
  <div class="release-actions">
    <p>{t("updates.planHint")}</p>
    <Button
      disabled={model.busy ||
        model.offline ||
        model.active ||
        !status.release ||
        !model.project ||
        !model.selected?.update_available}
      onclick={model.prepare}
      >{t("updates.plan")}<ArrowRight class="size-5" aria-hidden="true" /></Button
    >
  </div>
</section>

<style>
  .release-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    padding: 1.5rem;
  }
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
  .release-channel {
    font-size: 0.6875rem;
    border: 1px solid var(--border-strong);
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    color: var(--muted-foreground);
  }
  .project-field {
    display: grid;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }
  label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .select-wrap {
    position: relative;
  }
  .select-wrap > :global(svg) {
    position: absolute;
    left: 0.875rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted-foreground);
    pointer-events: none;
  }
  select {
    width: 100%;
    min-height: 2.75rem;
    border: 1px solid var(--input);
    border-radius: 0.5rem;
    background: var(--field);
    color: var(--foreground);
    font: inherit;
    font-size: 0.875rem;
    padding: 0.5rem 2rem 0.5rem 2.5rem;
    color-scheme: light dark;
  }
  select:disabled {
    opacity: 0.5;
  }
  .version-comparison {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 1.5rem;
    align-items: center;
    margin-top: 1.5rem;
    padding: 1.5rem;
    border-radius: 0.625rem;
    background: var(--well);
  }
  .version-comparison dt {
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }
  .version-comparison dd {
    margin-top: 0.625rem;
    font: 500 clamp(1.25rem, 2.3vw, 1.875rem)/1.2 var(--font-mono);
    overflow-wrap: anywhere;
  }
  .version-comparison .version-available {
    color: var(--brand);
  }
  .version-comparison :global(.version-arrow) {
    color: var(--muted-foreground);
  }
  .release-status {
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    line-height: 1.7;
    margin-top: 1rem;
  }
  .release-status p {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .release-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
    margin-top: 1.25rem;
  }
  .release-actions p {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    max-width: 17rem;
    line-height: 1.7;
  }
  @media (max-width: 480px) {
    .release-card {
      padding: 1.125rem;
    }
    .version-comparison {
      padding: 1rem;
      gap: 0.75rem;
    }
    .version-comparison dt {
      font-size: 0.6875rem;
    }
  }
</style>
