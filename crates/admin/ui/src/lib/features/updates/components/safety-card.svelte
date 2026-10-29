<script lang="ts">
  import { ShieldCheck, LockKeyhole } from "@lucide/svelte";
  import { t } from "$lib/i18n/index.svelte";
</script>

<aside class="safety-card" aria-labelledby="safety-title">
  <span class="safety-icon"><ShieldCheck class="size-5" aria-hidden="true" /></span>
  <h2 id="safety-title">{t("updates.safetyTitle")}</h2>
  <p>{t("updates.safetyHint")}</p>
  <ol class="safety-steps">
    <li>
      <span>01</span>
      <div>
        <h3>{t("updates.stepReview")}</h3>
        <p>{t("updates.stepReviewHint")}</p>
      </div>
    </li>
    <li>
      <span>02</span>
      <div>
        <h3>{t("updates.stepBackup")}</h3>
        <p>{t("updates.stepBackupHint")}</p>
      </div>
    </li>
    <li>
      <span>03</span>
      <div>
        <h3>{t("updates.stepValidate")}</h3>
        <p>{t("updates.stepValidateHint")}</p>
      </div>
    </li>
  </ol>
  <p class="safety-footnote">
    <LockKeyhole class="size-4 shrink-0" aria-hidden="true" />{t("updates.operatorConfirmation")}
  </p>
</aside>

<style>
  .safety-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    padding: 1.5rem;
  }
  .safety-icon {
    display: inline-flex;
    padding: 0.625rem;
    background: var(--brand-soft);
    color: var(--brand);
    border-radius: 0.625rem;
    margin-bottom: 1rem;
  }
  .safety-card h2 {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .safety-card > p {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1.8;
    margin-top: 0.5rem;
  }
  .safety-steps {
    display: grid;
    gap: 1.5rem;
    margin-top: 1.75rem;
  }
  .safety-steps li {
    display: flex;
    gap: 0.875rem;
  }
  .safety-steps li > span {
    font: 0.6875rem var(--font-mono);
    color: var(--muted-foreground);
    padding-top: 0.125rem;
  }
  .safety-steps h3 {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .safety-steps p {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    line-height: 1.7;
    margin-top: 0.375rem;
  }
  .safety-card .safety-footnote {
    display: flex;
    align-items: start;
    gap: 0.5rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    margin-top: 1.5rem;
  }
  @media (max-width: 1200px) {
    .safety-steps {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 480px) {
    .safety-card {
      padding: 1.125rem;
    }
    .safety-steps {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
