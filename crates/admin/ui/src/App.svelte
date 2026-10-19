<script lang="ts">
  import { onMount } from 'svelte'
  import { ModeWatcher } from 'mode-watcher'
  import Login from '$lib/features/auth/Login.svelte'
  import LoadingScreen from '$lib/shell/LoadingScreen.svelte'
  import { takeHandoffToken } from '$lib/features/projects/projects'
  import { api, ApiError } from '$lib/transport/api'
  import { Button } from '$lib/components/ui/button'
  import Logo from '$lib/shell/components/Logo.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { session } from '$lib/resources/session.svelte'
  import { route } from '$lib/navigation/router.svelte'
  import { crumbsFor, documentTitle } from '$lib/shell/titles'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  const controller = document.querySelector('meta[name=nelcota-updates-controller]')?.getAttribute('content') === '1'

  onMount(async () => {
    if (controller) return
    // Coming from another panel on the host (single sign-on): trade the token for a session.
    const token = takeHandoffToken()
    if (token) {
      try {
        session.email = (await api.post<{ email: string }>('/sso', { token })).email
        return
      } catch {
        // Expired or already used token: fall back to the normal login.
      }
    }
    await checkSession()
  })

  // Why the session check failed when it was not a plain "signed out" (401):
  // server down, proxy error… The login form would be misleading then.
  let offline = $state<unknown>(null)
  let checking = $state(false)

  async function checkSession() {
    checking = true
    try {
      const me = await api.get<{ email: string }>('/session')
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

  // Tab title: the current page (or the login) followed by the product name.
  const title = $derived(
    controller ? `${t('updates.controller')} · Nelcota` : session.email === null ? `${t('shell.pages.signIn')} · Nelcota` : session.email ? documentTitle(crumbsFor(route.path)) : 'Nelcota',
  )
</script>

<svelte:head><title>{title}</title></svelte:head>

<ModeWatcher defaultMode="dark" />
<!-- While the server is unreachable, try again by itself when the network or
     the window comes back. -->
<svelte:window ononline={retryWhenOffline} onfocus={retryWhenOffline} />
{#if !controller && (session.email === undefined && offline)}
  <!-- On a card like the login and the 404. -->
  <main class="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
    <div class="flex w-full max-w-md flex-col items-center gap-6 rounded-3xl bg-card px-8 pt-8 pb-10 text-center" role="alert">
      <Logo size="lg" />
      <div class="grid gap-2">
        <h1 class="text-xl font-semibold tracking-tight">{t('shell.app.offlineTitle')}</h1>
        <p class="text-sm text-muted-foreground">{errorMessage(offline)}</p>
      </div>
      <Button disabled={checking} onclick={checkSession}>
        {#if checking}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{t('common.retry')}
      </Button>
    </div>
  </main>
{/if}
{#if !controller && !(session.email === undefined && offline) && (session.email === undefined)}
  <LoadingScreen />
{/if}
{#if !controller && !(session.email === undefined && offline) && !(session.email === undefined) && (session.email === null)}
  <Login />
{/if}
{#if !controller && !(session.email === undefined && offline) && !(session.email === undefined) && !(session.email === null)}
  {#await import('$lib/shell/AuthenticatedShell.svelte')}
    <LoadingScreen />
  {:then shell}
    <shell.default />
  {:catch error}
    <main class="mx-auto flex min-h-dvh w-full max-w-xl items-center bg-background px-4 py-12">
      <div class="w-full"><LoadError message={errorMessage(error)} onretry={() => window.location.reload()} /></div>
    </main>
  {/await}
{/if}

{#if controller}
  {#await import('$lib/features/updates/UpdatesConsole.svelte')}<LoadingScreen />{:then updates}<updates.default />{:catch error}<main class="mx-auto max-w-xl p-8"><LoadError message={errorMessage(error)} onretry={() => window.location.reload()} /></main>{/await}
{/if}
