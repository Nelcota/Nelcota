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
  import Globe from '@lucide/svelte/icons/globe'
  import CircleHelp from '@lucide/svelte/icons/circle-help'
  import Logo from '$lib/shell/components/Logo.svelte'
  import { LOCALES, errorMessage, i18n, setLocale, t, type Locale } from '$lib/i18n/index.svelte'

  const year = new Date().getFullYear()

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

  // A failed language download, shown by the switcher (not as a sign-in error).
  let localeFailure = $state<unknown>(null)

  async function changeLocale(locale: Locale) {
    localeFailure = null
    try {
      await setLocale(locale)
    } catch (error) {
      localeFailure = error
    }
  }

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

<div class="login-page">
  <div class="login-frame">
    <main class="login-main">
      <header class="login-brand"><Logo /></header>
      <div class="login-content">
        <div class="login-heading">
          <h1>{t('login.title')}</h1>
          <p>{t('login.subtitle')}</p>
          {#if project}
            <p class="login-project"><span>{t('login.project')}</span><span translate="no">{project}</span></p>
          {/if}
        </div>
        <form class="login-form" onsubmit={submit} aria-busy={loading} novalidate>
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
              class="h-[54px] rounded-xl border-border-strong text-base md:text-base"
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
            <InputGroup.Root class="h-[54px] rounded-xl border-border-strong text-base md:text-base">
              <InputGroup.Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autocomplete="current-password"
                class="h-full text-base md:text-base"
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
            <div class="-mt-1 text-sm leading-5">
              <p id="login-error" class="break-words text-destructive" role="alert">{failure ? errorMessage(failure) : missing === 'password' ? t('login.passwordRequired') : ''}</p>
              <p id="login-caps-lock" class="text-warning" role="status" aria-live="polite">{!failure && !missing && capsLock ? t('login.capsLock') : ''}</p>
            </div>
          </Field.Field>
        </Field.Group>

        <Button type="submit" size="hero" class="h-[54px] w-full rounded-xl text-base font-medium sm:text-base" disabled={loading}>{#if loading}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}{loading ? t('login.signingIn') : t('login.signIn')}</Button>
        </form>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{loading ? t('login.signingIn') : ''}</p>
        <div class="login-support">
          <p>{t('login.restricted')}</p>
          <a href="https://github.com/Nelcota/Nelcota/blob/main/docs/README.md" target="_blank" rel="noreferrer">
            <CircleHelp size={17} aria-hidden="true" />{t('login.help')}
          </a>
        </div>
      </div>
    </main>
    <footer class="login-footer">
      <div class="login-languages" role="group" aria-label={t('shell.account.language')}>
        <Globe size={16} aria-hidden="true" />
        {#each LOCALES as locale (locale)}
          <button type="button" lang={locale} aria-pressed={i18n.locale === locale} onclick={() => changeLocale(locale)}>
            {t(`shell.languages.${locale}`)}
          </button>
        {/each}
      </div>
      {#if localeFailure !== null}<p class="login-language-error" role="alert">{errorMessage(localeFailure)}</p>{/if}
      <span aria-hidden="true">·</span>
      <span>© {year} Nelcota</span>
      <button
        type="button"
        class="login-theme"
        onclick={toggleMode}
        aria-label={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}
        title={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}
      >
        {#if mode.current === 'dark'}<Sun size={16} aria-hidden="true" />{/if}
        {#if mode.current !== 'dark'}<Moon size={16} aria-hidden="true" />{/if}
      </button>
    </footer>
  </div>
</div>

<style>
  .login-page {
    min-height: 100dvh;
    padding: 18px 28px 0;
    background: var(--muted);
  }
  .login-frame {
    display: flex;
    min-height: calc(100dvh - 18px);
    flex-direction: column;
    border-radius: 30px 30px 0 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--primary) 3%, var(--background)), var(--background) 48%);
  }
  :global(.dark) .login-page { background: #2b2b2b; }
  :global(.dark) .login-frame {
    --background: #202020;
    --field: #292929;
    --border-strong: #555555;
    --ring: var(--primary);
    --brand: var(--primary);
    background: linear-gradient(180deg, #20232b, #202020 48%);
  }
  .login-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    padding: clamp(36px, 8vh, 88px) 24px 64px;
  }
  .login-brand { display: flex; justify-content: center; }
  .login-content { width: 100%; max-width: 494px; margin-top: 36px; }
  .login-heading { margin-bottom: 32px; text-align: center; }
  .login-heading h1 { font-size: clamp(26px, 3vw, 32px); font-weight: 600; letter-spacing: -0.045em; line-height: 1.3; }
  .login-heading > p { margin-top: 10px; font-size: 18px; color: var(--muted-foreground); }
  .login-heading .login-project { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px; margin-top: 16px; font-size: 13px; overflow-wrap: anywhere; }
  .login-project span:last-child { color: var(--foreground); }
  .login-form { display: flex; flex-direction: column; gap: 20px; }
  .login-form :global([data-slot="field-label"]) { font-size: 16px; font-weight: 500; }
  .login-support { margin-top: 36px; border-top: 1px solid var(--border); padding-top: 24px; text-align: center; font-size: 14px; color: var(--muted-foreground); }
  .login-support a { display: inline-flex; align-items: center; gap: 8px; margin-top: 32px; }
  .login-support a:hover { color: var(--foreground); }
  .login-footer { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px; padding: 20px 24px; color: var(--muted-foreground); font-size: 13px; }
  .login-languages { display: flex; align-items: center; gap: 8px; }
  .login-footer button { cursor: pointer; }
  .login-languages button[aria-pressed="true"] { color: var(--foreground); font-weight: 600; }
  .login-language-error { flex-basis: 100%; text-align: center; color: var(--destructive); }
  .login-footer button:hover { color: var(--foreground); }
  .login-footer button:focus-visible, .login-support a:focus-visible { outline: 2px solid var(--primary); outline-offset: 5px; border-radius: 3px; }
  .login-theme { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 50%; }
  .login-theme:hover { background: var(--accent); }
  @media (max-width: 600px) {
    .login-page { padding: 8px 8px 0; }
    .login-frame { min-height: calc(100dvh - 8px); border-radius: 22px 22px 0 0; }
    .login-main { padding: 28px 20px 40px; }
    .login-content { margin-top: 24px; }
    .login-heading > p { font-size: 15px; }
    .login-footer { gap: 8px; padding: 16px 12px; font-size: 12px; }
  }
</style>
