<script lang="ts">
  import { onMount, type Component } from 'svelte'
  import { ModeWatcher } from 'mode-watcher'
  import Login from '$lib/features/auth/Login.svelte'
  import LoadingScreen from '$lib/shell/LoadingScreen.svelte'
  import { api, ApiError } from '$lib/transport/api'
  import OfflineScreen from '$lib/shell/OfflineScreen.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import { session } from '$lib/resources/session.svelte'
  import { preloadResponseContracts } from '$lib/contracts/responses'
  import { rememberSignedIn } from '$lib/shell/prefetch'
  import { route } from '$lib/navigation/router.svelte'
  import { crumbsFor, documentTitle } from '$lib/shell/titles'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  // Decided in main.ts, which also starts the session check (or reads the
  // single sign-on token) while the language loads.
  let { controller, handoffToken, sessionCheck }: {
    controller: boolean
    handoffToken: string | null
    sessionCheck: Promise<{ email: string }> | null
  } = $props()

  onMount(async () => {
    if (controller) return
    if (handoffToken === null) {
      await checkSession(sessionCheck ?? undefined)
      return
    }
    // Coming from another panel on the host (single sign-on): trade the token for a session.
    try {
      session.email = (await api.post<{ email: string }>('/sso', { token: handoffToken })).email
      return
    } catch {
      // Expired or already used token: fall back to the normal login.
    }
    await checkSession()
  })

  // Why the session check failed when it was not a plain "signed out" (401):
  // server down, proxy error… The login form would be misleading then.
  let offline = $state<unknown>(null)
  let checking = $state(false)

  async function checkSession(pending: Promise<{ email: string }> = api.get<{ email: string }>('/session')) {
    checking = true
    try {
      const me = await pending
      offline = null
      session.email = me.email
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        offline = null
        session.email = null
        return
      }
      offline = e
    } finally {
      checking = false
    }
  }

  function retryWhenOffline() {
    if (offline && !checking) void checkSession()
  }

  // The hint main.ts reads to fetch the panel's code early on the next visit.
  $effect(() => {
    if (controller) return
    if (typeof session.email === 'string') rememberSignedIn(true)
    if (session.email === null) rememberSignedIn(false)
  })

  // The signed-in panel's code, needed once there is a session (main.ts may
  // have started downloading it alongside the session check). Kept in state
  // rather than an {#await}, so the startup screen stays mounted from the
  // session check until the panel is ready and moves on to its next step.
  let Shell = $state<Component | null>(null)
  let shellError = $state<unknown>(null)
  let shellRequested = false
  $effect(() => {
    if (controller || !session.email || shellRequested) return
    shellRequested = true
    preloadResponseContracts()
    import('$lib/shell/AuthenticatedShell.svelte')
      .then((module) => (Shell = module.default))
      .catch((error: unknown) => (shellError = error))
  })

  const unreachable = $derived(session.email === undefined && !!offline)
  const booting = $derived(!controller && !unreachable && session.email !== null && !Shell && !shellError)

  // Tab title: the current page (or the login) followed by the product name.
  const title = $derived(
    controller ? `${t('updates.controller')} · Nelcota` : session.email === null ? `${t('shell.pages.signIn')} · Nelcota` : session.email ? documentTitle(crumbsFor(route.path)) : 'Nelcota',
  )
</script>

<svelte:head><title>{title}</title></svelte:head>

<!-- src/theme-init.js already set the theme before the first paint (and the
     CSP would block the inline script mode-watcher injects for that). -->
<ModeWatcher defaultMode="dark" disableHeadScriptInjection />
<!-- While the server is unreachable, try again by itself when the network or
     the window comes back. -->
<svelte:window ononline={retryWhenOffline} onfocus={retryWhenOffline} />
{#if booting}
  <LoadingScreen stage={session.email ? 'panel' : 'session'} />
{/if}
{#if !controller && unreachable}
  <OfflineScreen error={offline} {checking} onretry={() => checkSession()} />
{/if}
{#if !controller && session.email === null}
  <Login />
{/if}
{#if !controller && session.email && Shell}
  <Shell />
{/if}
{#if !controller && session.email && shellError}
  <main class="mx-auto flex min-h-dvh w-full max-w-xl items-center bg-background px-4 py-12">
    <div class="w-full"><LoadError message={errorMessage(shellError)} onretry={() => window.location.reload()} /></div>
  </main>
{/if}

{#if controller}
  {#await import('$lib/features/updates/UpdatesConsole.svelte')}<LoadingScreen stage="panel" />{:then updates}<updates.default />{:catch error}<main class="mx-auto max-w-xl p-8"><LoadError message={errorMessage(error)} onretry={() => window.location.reload()} /></main>{/await}
{/if}
