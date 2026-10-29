<script lang="ts">
  import {
    ArrowRight,
    Server,
    ShieldCheck,
    RotateCcwClock as History,
    LockKeyhole,
    Download,
  } from "@lucide/svelte";
  import { Button, Input } from "$lib/components/ui";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  let { model }: { model: UpdatesConsoleState } = $props();
</script>

<div class="operator-login">
  <section class="login-intro">
    <span class="eyebrow">{t("updates.console")}</span>
    <h1>{t("updates.loginTitle")}</h1>
    <p>{t("updates.loginSubtitle")}</p>
    <div class="login-diagram" aria-hidden="true">
      <Server class="size-8" /><span></span><ShieldCheck class="size-9 text-brand" /><span
      ></span><Download class="size-8" />
    </div>
    <div class="login-feature">
      <ShieldCheck class="size-5" aria-hidden="true" />
      <div>
        <h2>{t("updates.verifiedTitle")}</h2>
        <p>{t("updates.verifiedHint")}</p>
      </div>
    </div>
    <div class="login-feature">
      <History class="size-5" aria-hidden="true" />
      <div>
        <h2>{t("updates.recoveryTitle")}</h2>
        <p>{t("updates.recoveryHint")}</p>
      </div>
    </div>
  </section>
  <section class="login-card" aria-labelledby="operator-login-title">
    <span class="login-lock"><LockKeyhole class="size-5" aria-hidden="true" /></span>
    <h2 id="operator-login-title">{t("updates.operatorAccess")}</h2>
    <p class="login-description">{t("updates.authority")}</p>
    <form onsubmit={model.login} class="grid gap-5" aria-busy={model.busy}>
      <div class="grid gap-2">
        <label for="operator-email">{t("login.email")}</label><Input
          id="operator-email"
          type="email"
          autocomplete="username"
          required
          maxlength={254}
          bind:value={model.email}
          disabled={model.busy}
        />
      </div>
      <div class="grid gap-2">
        <label for="operator-password">{t("login.password")}</label><Input
          id="operator-password"
          type="password"
          autocomplete="current-password"
          required
          maxlength={1024}
          bind:value={model.password}
          disabled={model.busy}
        />
      </div>
      <Button type="submit" class="w-full" disabled={model.busy}
        >{model.busy ? t("updates.working") : t("login.signIn")}<ArrowRight
          class="size-4"
          aria-hidden="true"
        /></Button
      >
    </form>
    <p class="login-footnote">
      <LockKeyhole class="size-3.5 shrink-0" aria-hidden="true" />{t("updates.separateAccess")}
    </p>
  </section>
</div>

<style>
  .eyebrow {
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    font-weight: 600;
  }
  label {
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .login-lock {
    display: inline-flex;
    padding: 0.625rem;
    background: var(--brand-soft);
    color: var(--brand);
    border-radius: 0.625rem;
    margin-bottom: 1rem;
  }
  .operator-login {
    max-width: 64rem;
    min-height: calc(100dvh - 12rem);
    margin: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 25rem);
    align-items: center;
    gap: clamp(2rem, 6vw, 6rem);
  }
  .login-intro h1 {
    font-size: clamp(2rem, 3.5vw, 3rem);
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.045em;
    margin-top: 1rem;
    text-wrap: balance;
  }
  .login-intro > p {
    font-size: 0.9375rem;
    line-height: 1.8;
    color: var(--muted-foreground);
    margin-top: 1rem;
  }
  .login-diagram {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 2rem 0;
    max-width: 21rem;
    color: var(--muted-foreground);
  }
  .login-diagram span {
    height: 1px;
    flex: 1;
    background: var(--border-strong);
  }
  .login-feature {
    display: flex;
    gap: 0.875rem;
    margin-top: 1rem;
  }
  .login-feature > :global(svg) {
    color: var(--muted-foreground);
    flex-shrink: 0;
    margin-top: 0.125rem;
  }
  .login-feature h2 {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .login-feature p {
    font-size: 0.75rem;
    line-height: 1.7;
    color: var(--muted-foreground);
    margin-top: 0.25rem;
  }
  .login-card {
    border: 1px solid var(--border-strong);
    border-radius: 1rem;
    padding: 2rem;
    background: var(--card);
  }
  .login-card h2 {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.025em;
  }
  .login-description {
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    line-height: 1.8;
    margin: 0.75rem 0 1.75rem;
  }
  .login-footnote {
    display: flex;
    gap: 0.5rem;
    align-items: start;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1.7;
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
    margin-top: 1.5rem;
  }
  @media (max-width: 800px) {
    .operator-login {
      grid-template-columns: minmax(0, 1fr);
      gap: 1.75rem;
      max-width: 28rem;
      min-height: auto;
      padding: 1rem 0;
    }
    .login-intro h1 {
      font-size: 2rem;
    }
    .login-diagram,
    .login-feature {
      display: none;
    }
    .login-card {
      padding: 1.5rem;
    }
  }
</style>
