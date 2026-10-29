<script lang="ts">
  import { ShieldCheck, CircleAlert } from "@lucide/svelte";
  import { Button, Input } from "$lib/components/ui";
  import { blocker } from "../presentation";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  import type { Status } from "../controller";
  let { model, status }: { model: UpdatesConsoleState; status: Status } = $props();
</script>

{#if model.plan || model.recover}
  <form
    onsubmit={model.approve}
    class="review-card"
    aria-busy={model.busy}
    aria-labelledby="review-title"
  >
    <h2 id="review-title">
      <ShieldCheck class="size-5" aria-hidden="true" />{t(
        model.recover ? "updates.recover" : "updates.review",
      )}
    </h2>
    {#if model.plan}<p class="review-version" translate="no">
        {model.plan.project}: {model.plan.current} → {model.plan.target}
      </p>
      <div class="artifact-identity">
        <span>{t("updates.digest")}</span><code translate="no">{model.plan.digest}</code>
      </div>
      <p class="text-sm text-muted-foreground">{t("updates.expires")}</p>
      {#if model.plan.blockers.length}<div class="requirements">
          <h3>{t("updates.requirements")}</h3>
          <ul>
            {#each model.plan.blockers as code}<li>
                <CircleAlert class="size-4 shrink-0" aria-hidden="true" />{blocker(code)}
              </li>{/each}
          </ul>
        </div>{/if}{/if}
    {#if model.recover}<p>
        {t(model.recover.committed ? "updates.committed" : "updates.uncommitted")}
      </p>
      <p class="review-version" translate="no">
        {model.recover.project}: {model.recover.current} → {model.recover.target}
      </p>{/if}
    <p class="impact-note">{t("updates.impact")}</p>
    <div class="grid gap-2">
      <label for="approval-password">{t("updates.password")}</label><Input
        id="approval-password"
        type="password"
        autocomplete="current-password"
        required
        maxlength={1024}
        bind:value={model.approval}
        disabled={model.busy ||
          model.offline ||
          (model.plan !== null && (model.plan.blockers.length > 0 || !status.enabled))}
      />
    </div>
    <div class="flex flex-wrap gap-3">
      <Button
        type="submit"
        disabled={model.busy ||
          model.offline ||
          !model.approval ||
          (model.plan !== null && (model.plan.blockers.length > 0 || !status.enabled))}
        >{t(model.recover ? "updates.recover" : "updates.approve")}</Button
      ><Button type="button" variant="outline" onclick={model.clearApproval} disabled={model.busy}
        >{t("common.cancel")}</Button
      >
    </div>
  </form>
{/if}

<style>
  .review-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    padding: 1.5rem;
  }

  .review-card h2 {
    display: flex;
    gap: 0.625rem;
    align-items: center;
    font-size: 0.875rem;
    font-weight: 600;
  }
  label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .review-card {
    display: grid;
    gap: 1.25rem;
    border-color: color-mix(in srgb, var(--brand) 30%, transparent);
  }
  .review-version {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .artifact-identity {
    background: var(--well);
    padding: 0.875rem;
    border-radius: 0.5rem;
    display: grid;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }
  .artifact-identity code {
    overflow-wrap: anywhere;
    color: var(--foreground);
  }
  .requirements h3 {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
  }
  .requirements li {
    display: flex;
    align-items: start;
    gap: 0.5rem;
    font-size: 0.8125rem;
    margin-top: 0.5rem;
    color: var(--warning);
  }
  .impact-note {
    border-left: 2px solid var(--warning);
    padding-left: 0.875rem;
    font-size: 0.8125rem;
    color: var(--muted-foreground);
    line-height: 1.7;
  }
  @media (max-width: 480px) {
    .review-card {
      padding: 1.125rem;
    }
  }
</style>
