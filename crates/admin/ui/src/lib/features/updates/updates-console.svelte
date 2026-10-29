<script lang="ts">
  import { onMount } from "svelte";
  import { OperatorLogin, ConsoleSidebar, ReleaseWorkspace } from "./components";
  import { mode, toggleMode } from "mode-watcher";
  import { RefreshCw, LogOut, SunMoon, CircleAlert } from "@lucide/svelte";
  import { Button } from "$lib/components/ui";
  import Logo from "$lib/shell/components/logo.svelte";
  import HostConsole from "../host/host-console.svelte";
  import type { HostArea } from "../host/navigation";
  import { t, i18n, setLocale, errorMessage } from "$lib/i18n/index.svelte";
  import { UpdatesConsoleState } from "./console-state.svelte";
  let hostArea = $state<HostArea>("projects");
  let view = $state<"projects" | "updates">("projects");
  let hostConsole = $state<HostConsole>();
  const model = new UpdatesConsoleState();
  onMount(model.mount);
  function selectHostArea(area: HostArea) {
    view = "projects";
    if (hostConsole != null) {
      hostConsole.selectArea(area);
      return;
    }
    hostArea = area;
  }
  function selectUpdates() {
    if (hostConsole != null) {
      hostConsole.leave(() => {
        view = "updates";
      });
      return;
    }
    view = "updates";
  }
  async function switchLanguage() {
    try {
      await setLocale(i18n.locale === "pt-BR" ? "en" : "pt-BR");
    } catch (error) {
      model.failure = errorMessage(error);
    }
  }
</script>

<svelte:window
  ononline={() => void model.refresh()}
  onfocus={() => {
    if (!model.signedOut) void model.refresh();
  }}
/>
<div class="updates-app">
  <a class="skip-link" href="#updates-content">{t("updates.skip")}</a>
  <header class="console-header">
    <div class="console-brand">
      <Logo mark /><span class="console-label">{t("updates.console")}</span>
    </div>
    <div class="console-tools">
      <Button variant="ghost" size="sm" onclick={switchLanguage}
        >{i18n.locale === "pt-BR" ? "English" : "Português"}</Button
      >
      <Button
        variant="ghost"
        size="icon"
        onclick={toggleMode}
        aria-label={mode.current === "dark"
          ? t("shell.account.lightTheme")
          : t("shell.account.darkTheme")}><SunMoon class="size-4" aria-hidden="true" /></Button
      >
      {#if model.status}<Button
          variant="ghost"
          size="sm"
          disabled={model.busy}
          onclick={() => {
            if (hostConsole != null) {
              hostConsole.leave(() => {
                void model.logout();
              });
              return;
            }
            void model.logout();
          }}
          ><LogOut class="size-4" aria-hidden="true" /><span class="sr-only sm:not-sr-only"
            >{t("shell.account.signOut")}</span
          ></Button
        >{/if}
    </div>
  </header>
  <div class:authenticated={model.status !== null} class="console-layout">
    {#if model.status}
      <ConsoleSidebar
        {model}
        status={model.status}
        {view}
        {hostArea}
        navigationBusy={() => hostConsole?.navigationBusy() ?? false}
        onarea={selectHostArea}
        onupdates={selectUpdates}
      />
    {/if}
    <main id="updates-content" tabindex="-1" class="console-main">
      {#if model.failure}<div class="notice notice-error" role="alert">
          <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
          <p>{model.failure}</p>
        </div>{/if}
      {#if model.offline}<div role="status" class="notice">
          <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
          <p>{t("updates.reconnect")}</p>
          <Button variant="outline" size="sm" onclick={() => void model.refresh()}
            >{t("updates.retry")}</Button
          >
        </div>{/if}
      {#if !model.status && !model.signedOut && !model.offline}<div
          class="console-loading"
          role="status"
        >
          <RefreshCw class="size-5 motion-safe:animate-spin" aria-hidden="true" />
          <p>{t("shell.app.loading")}</p>
        </div>{/if}
      {#if model.signedOut}
        <OperatorLogin {model} />
      {/if}
      {#if model.status}
        {#if model.status.host_management && view === "projects"}
          <div class="page-heading">
            <div>
              <span class="eyebrow">{t("updates.console")}</span>
              <h1>{t("updates.controller")}</h1>
            </div>
          </div>
          {#key model.status.email}<HostConsole
              bind:this={hostConsole}
              bind:area={hostArea}
              email={model.status.email}
              expired={model.expire}
            />{/key}
        {/if}
        {#if !model.status.host_management || view === "updates"}
          <ReleaseWorkspace {model} status={model.status} />
        {/if}
      {/if}
    </main>
  </div>
</div>

<style>
  .updates-app {
    min-height: 100dvh;
    background: var(--background);
    color: var(--foreground);
  }
  .skip-link {
    position: fixed;
    top: -5rem;
    left: 1rem;
    z-index: 50;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: var(--primary);
    color: var(--primary-foreground);
  }
  .skip-link:focus {
    top: 0.5rem;
  }
  .console-header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--background);
    min-height: 4.5rem;
    padding: 0 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .console-brand,
  .console-tools {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .console-label {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    border-left: 1px solid var(--border-strong);
    padding-left: 1rem;
  }
  .console-layout.authenticated {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
    min-height: calc(100dvh - 4.5rem);
  }
  .eyebrow {
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    font-weight: 600;
  }
  .console-main {
    min-width: 0;
    padding: 2.5rem clamp(1.25rem, 3vw, 3.5rem);
    max-width: 100rem;
    width: 100%;
    margin-inline: auto;
  }
  .console-main:focus {
    outline: none;
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
  .notice > p {
    flex: 1;
    min-width: 12rem;
  }
  .notice p {
    line-height: 1.65;
    color: var(--muted-foreground);
  }
  .notice-error,
  .notice-error p {
    color: var(--destructive);
  }
  .console-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    min-height: 50dvh;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }
  @media (max-width: 800px) {
    .console-header {
      padding: 0.75rem 1rem;
      gap: 0.5rem;
    }
    .console-label {
      display: none;
    }
    .console-layout.authenticated {
      grid-template-columns: minmax(0, 1fr);
      min-height: auto;
    }
    .console-main {
      padding: 1.5rem 1rem;
    }
  }
  @media (max-width: 480px) {
    .console-tools {
      gap: 0.125rem;
    }
    .console-brand {
      gap: 0.25rem;
    }
    .page-heading h1 {
      font-size: 1.625rem;
    }
    .notice {
      padding: 1rem;
    }
  }
</style>
