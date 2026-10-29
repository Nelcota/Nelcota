<script lang="ts">
  import { RefreshCw, LockKeyhole } from "@lucide/svelte";
  import { Button } from "$lib/components/ui";
  import { mergeStatus, parseStatus } from "../controller";
  import ReleaseCard from "./release-card.svelte";
  import ApprovalForm from "./approval-form.svelte";
  import JobHistory from "./job-history.svelte";
  import SafetyCard from "./safety-card.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  import type { Status } from "../controller";
  let { model, status }: { model: UpdatesConsoleState; status: Status } = $props();
</script>

<header class="page-heading">
  <div>
    <span class="eyebrow">{t("updates.controller")}</span>
    <h1>{t("updates.title")}</h1>
    <p>{t("updates.subtitle")}</p>
  </div>
  <Button
    variant="outline"
    disabled={model.busy || model.offline || status.checking}
    onclick={() =>
      void model.act({ action: "check" }, (reply) => {
        model.status = mergeStatus(model.status, parseStatus(reply.data));
      })}
    ><RefreshCw
      class={["size-4", status.checking && "motion-safe:animate-spin"]}
      aria-hidden="true"
    />{t("updates.check")}</Button
  >
</header>
{#if !status.enabled}<div class="notice notice-warning" role="status">
    <LockKeyhole class="size-5 shrink-0" aria-hidden="true" />
    <div>
      <h2>{t("updates.installationLocked")}</h2>
      <p>{t("updates.disabled")}</p>
    </div>
  </div>{/if}
<div class="updates-grid">
  <div class="updates-primary">
    <ReleaseCard {model} {status} />
    <ApprovalForm {model} {status} />
    <JobHistory {model} {status} />
  </div>
  <SafetyCard />
</div>

<style>
  .eyebrow {
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    font-weight: 600;
  }
  .page-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1.25rem;
    margin-bottom: 2rem;
  }
  .page-heading h1 {
    font-size: 1.875rem;
    font-weight: 650;
    letter-spacing: -0.04em;
    line-height: 1.3;
    margin-top: 0.375rem;
  }
  .page-heading p {
    color: var(--muted-foreground);
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    border: 1px solid var(--border-strong);
    background: var(--card);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    margin-bottom: 1.5rem;
    font-size: 0.8125rem;
  }
  .notice-warning {
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
    background: color-mix(in srgb, var(--warning) 5%, var(--background));
  }
  .notice-warning > :global(svg) {
    color: var(--warning);
  }
  .notice h2 {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .notice p {
    line-height: 1.65;
    color: var(--muted-foreground);
  }
  .updates-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    align-items: start;
    gap: 1.5rem;
  }
  .updates-primary {
    min-width: 0;
    display: grid;
    gap: 1.5rem;
  }
  @media (max-width: 1200px) {
    .updates-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 480px) {
    .page-heading h1 {
      font-size: 1.625rem;
    }
    .notice {
      padding: 1rem;
    }
  }
</style>
