<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Field from '$lib/components/ui/field'
  import * as InputGroup from '$lib/components/ui/input-group'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Sun from '@lucide/svelte/icons/sun'
  import Moon from '@lucide/svelte/icons/moon'
  import { mode, toggleMode } from 'mode-watcher'
  import { api } from '$lib/transport/api'
  import { session } from '$lib/resources/session.svelte'
  import Flag from '$lib/shell/components/Flag.svelte'
  import Logo from '$lib/shell/components/Logo.svelte'
  import { LOCALES, errorMessage, i18n, setLocale, t, type Locale } from '$lib/i18n/index.svelte'

  // Short codes on the switch; each option names its language in full for
  // screen readers and on hover, in that language.
  const CODES: Record<Locale, string> = { 'pt-BR': 'PT', en: 'EN' }

  let project = $state('')
  onMount(() => {
    // Signing in is the only thing to do here: start in the email field.
    document.getElementById('email')?.focus()
    api
      .get<{ project: string }>('/whoami')
      .then((r) => (project = r.project))
      .catch(() => (project = ''))
  })

  let email = $state('')
  let password = $state('')
  // The failure itself (not its text), so the message follows a language switch.
  let failure = $state<unknown>(null)
  // A field left empty, checked here instead of by the browser so the hint
  // follows the panel language rather than the browser's.
  let missing = $state<'email' | 'password' | null>(null)
  let loading = $state(false)
  let showPassword = $state(false)
  let capsLock = $state(false)

  function checkCapsLock(event: KeyboardEvent) {
    capsLock = event.getModifierState('CapsLock')
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (loading) return
    missing = !email.trim() ? 'email' : !password ? 'password' : null
    if (missing) {
      failure = null
      document.getElementById(missing)?.focus()
      return
    }
    loading = true
    failure = null
    try {
      const me = await api.post<{ email: string }>('/login', { email, password })
      session.expired = false
      session.email = me.email
    } catch (e) {
      failure = e
      document.getElementById('password')?.focus()
    } finally {
      loading = false
    }
  }

</script>

<div class="flex min-h-dvh flex-col bg-background px-4 py-4 sm:px-6 sm:py-6">
  <!-- The same bar as the signed-in panel: who this server is on the left,
       language and theme on the right (the account menu is not there yet). -->
  <header class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2 rounded-full bg-card py-1.5 ps-1.5 pe-4">
      <!-- On a phone the mark alone, so the project name has the room. -->
      <span class="flex shrink-0 sm:hidden"><Logo mark /></span>
      <span class="hidden shrink-0 sm:flex"><Logo /></span>
      {#if project}
        <span class="mx-1 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true"></span>
        <span class="hidden text-sm text-muted-foreground sm:inline">{t('login.project')}</span>
        <span class="text-sm font-semibold [overflow-wrap:anywhere]" translate="no">{project}</span>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <div class="panel-segments" role="group" aria-label={t('shell.account.language')}>
        {#each LOCALES as locale (locale)}
          {@const current = i18n.locale === locale}
          <button
            type="button"
            lang={locale}
            aria-pressed={current}
            aria-label={t(`shell.languages.${locale}`)}
            title={t(`shell.languages.${locale}`)}
            class="panel-segment"
            onclick={() => setLocale(locale)}><Flag {locale} class="size-[18px]" />{CODES[locale]}</button
          >
        {/each}
      </div>
      <button
        type="button"
        class="grid size-11 cursor-pointer place-items-center rounded-full bg-card text-muted-foreground transition-colors hover:text-foreground"
        onclick={toggleMode}
        aria-label={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}
        title={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}
      >
        {#if (mode.current === 'dark')}<Sun class="size-[18px]" aria-hidden="true" />{/if}
        {#if !(mode.current === 'dark')}<Moon class="size-[18px]" aria-hidden="true" />{/if}
      </button>
    </div>
  </header>

  <main class="flex flex-1 flex-col items-center justify-center gap-5 pt-6 pb-10">
    <div class="relative w-full max-w-[440px]">

      <form class="relative flex flex-col gap-5 rounded-3xl bg-card px-6 pt-8 pb-7 sm:px-9 sm:pt-9 sm:pb-8" onsubmit={submit} aria-busy={loading} novalidate>
        <div>
          <h1 class="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{t('login.title')}</h1>
          <p class="mt-1.5 text-[15px] text-muted-foreground">{t('login.subtitle')}</p>
        </div>
        {#if session.expired}
          <p class="rounded-2xl bg-well px-4 py-3 text-sm text-muted-foreground" role="status">{t('login.sessionExpired')}</p>
        {/if}

        <Field.Group class="gap-5">
          <Field.Field data-invalid={missing === 'email' ? true : undefined}>
            <Field.Label for="email">{t('login.email')}</Field.Label>
            <Input
              id="email"
              name="email"
              type="email"
              autocomplete="username"
              spellcheck={false}
              placeholder={t('login.emailPlaceholder')}
              class="h-11"
              readonly={loading}
              bind:value={email}
              oninput={() => {
                failure = null
                if (missing === 'email') missing = null
              }}
              required
              aria-invalid={missing === 'email' ? true : undefined}
              aria-describedby={missing === 'email' ? 'login-email-error' : undefined}
            />
            {#if missing === 'email'}<p id="login-email-error" class="text-sm text-destructive" role="alert">{t('login.emailRequired')}</p>{/if}
          </Field.Field>
          <Field.Field data-invalid={failure || missing === 'password' ? true : undefined}>
            <Field.Label for="password">{t('login.password')}</Field.Label>
            <InputGroup.Root class="h-11">
              <InputGroup.Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autocomplete="current-password"
                class="h-full"
                readonly={loading}
                bind:value={password}
                onblur={() => { capsLock = false }}
                onkeydown={checkCapsLock}
                onkeyup={checkCapsLock}
                oninput={() => {
                  failure = null
                  if (missing === 'password') missing = null
                }}
                required
                aria-invalid={failure || missing === 'password' ? true : undefined}
                aria-describedby={failure || missing === 'password' ? 'login-error' : capsLock ? 'login-caps-lock' : undefined}
              />
              <InputGroup.Addon align="inline-end" class="py-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={loading}
                  aria-label={t(showPassword ? 'common.hidePassword' : 'common.showPassword')}
                  aria-pressed={showPassword}
                  onclick={() => { showPassword = !showPassword; document.getElementById('password')?.focus() }}
                >
                  {#if (showPassword)}<EyeOff aria-hidden="true" />{/if}
                  {#if !(showPassword)}<Eye aria-hidden="true" />{/if}
                </Button>
              </InputGroup.Addon>
            </InputGroup.Root>
            <!-- One line kept for the error or the Caps Lock hint, so the button
                 does not jump when either appears; a longer error grows the card. -->
            <div class="-mt-1 min-h-5 text-sm leading-5">
              <p id="login-error" class="break-words text-destructive" role="alert">{failure ? errorMessage(failure) : missing === 'password' ? t('login.passwordRequired') : ''}</p>
              <p id="login-caps-lock" class="text-warning" role="status" aria-live="polite">{!failure && !missing && capsLock ? t('login.capsLock') : ''}</p>
            </div>
          </Field.Field>
        </Field.Group>

        <Button type="submit" class="mt-1 w-full" disabled={loading}>{#if loading}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{loading ? t('login.signingIn') : t('login.signIn')}</Button>
      </form>

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{loading ? t('login.signingIn') : ''}</p>
    </div>
    <p class="text-center text-sm text-muted-foreground">{t('login.restricted')}</p>
  </main>
</div>
