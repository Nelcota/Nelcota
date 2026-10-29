<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { ModeWatcher } from "mode-watcher";
  import Login from "$lib/features/auth/login.svelte";
  import {
    StartupSession,
    loadAuthenticatedShell,
    LoadingScreen,
    OfflineScreen,
  } from "$lib/shell/startup";
  import LoadError from "$lib/components/shared/load-error.svelte";
  import { session } from "$lib/resources/session.svelte";
  import { route } from "$lib/navigation/router.svelte";
  import { crumbsFor, documentTitle } from "$lib/shell/titles";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  // Decided in main.ts, which also starts the session check (or reads the
  // single sign-on token) while the language loads.
  let {
    controller,
    handoffToken,
    sessionCheck,
  }: {
    controller: boolean;
    handoffToken: string | null;
    sessionCheck: Promise<{ email: string }> | null;
  } = $props();

  const startup = new StartupSession();
  onMount(async () => {
    if (controller) return;
    await startup.start(handoffToken, sessionCheck ?? undefined);
  });
  const checkSession = () => startup.check();

  function retryWhenOffline() {
    if (Boolean(startup.offline) && startup.checking === false) void checkSession();
  }

  // Signing out in another tab signs this one out too, dropping cached reads.
  $effect(() => {
    if (controller) return;
    return startup.watch();
  });

  // The hint main.ts reads to fetch the panel's code early on the next visit.
  $effect(() => {
    if (controller) return;
    startup.syncHint();
  });

  // The signed-in panel's code, needed once there is a session (main.ts may
  // have started downloading it alongside the session check). Kept in state
  // rather than an {#await}, so the startup screen stays mounted from the
  // session check until the panel is ready and moves on to its next step.
  let Shell = $state<Component | null>(null);
  let shellError = $state<unknown>(null);
  let shellRequested = false;
  $effect(() => {
    if (controller || Boolean(session.email) === false || shellRequested) return;
    shellRequested = true;
    loadAuthenticatedShell()
      .then((module) => (Shell = module.default))
      .catch((error: unknown) => (shellError = error));
  });

  const unreachable = $derived(session.email === undefined && Boolean(startup.offline));
  const booting = $derived(
    controller === false &&
      unreachable === false &&
      session.email !== null &&
      Shell == null &&
      Boolean(shellError) === false,
  );

  // Tab title: the current page (or the login) followed by the product name.
  function pageTitle(): string {
    if (controller) return `${t("updates.controller")} · Nelcota`;
    if (session.email === null) return `${t("shell.pages.signIn")} · Nelcota`;
    if (session.email !== undefined && session.email !== "")
      return documentTitle(crumbsFor(route.path));
    return "Nelcota";
  }
  const title = $derived(pageTitle());
</script>

<svelte:head><title>{title}</title></svelte:head>

<!-- src/theme-init.js already set the theme before the first paint (and the
     CSP would block the inline script mode-watcher injects for that). -->
<ModeWatcher defaultMode="dark" disableHeadScriptInjection />
<!-- While the server is unreachable, try again by itself when the network or
     the window comes back. -->
<svelte:window ononline={retryWhenOffline} onfocus={retryWhenOffline} />
{#if booting}
  <LoadingScreen stage={session.email ? "panel" : "session"} />
{/if}
{#if !controller && unreachable}
  <OfflineScreen
    error={startup.offline}
    checking={startup.checking}
    onretry={() => checkSession()}
  />
{/if}
{#if !controller && session.email === null}
  <Login />
{/if}
{#if !controller && session.email && Shell}
  <Shell />
{/if}
{#if !controller && session.email && shellError}
  <main class="mx-auto flex min-h-dvh w-full max-w-xl items-center bg-background px-4 py-12">
    <div class="w-full">
      <LoadError message={errorMessage(shellError)} onretry={() => window.location.reload()} />
    </div>
  </main>
{/if}

{#if controller}
  {#await import("$lib/features/updates/updates-console.svelte")}<LoadingScreen
      stage="panel"
    />{:then updates}<updates.default />{:catch error}<main class="mx-auto max-w-xl p-8">
      <LoadError message={errorMessage(error)} onretry={() => window.location.reload()} />
    </main>{/await}
{/if}
