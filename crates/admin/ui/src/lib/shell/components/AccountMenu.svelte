<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { mode, toggleMode } from 'mode-watcher'
  import Sun from '@lucide/svelte/icons/sun'
  import Moon from '@lucide/svelte/icons/moon'
  import LogOut from '@lucide/svelte/icons/log-out'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ImageUp from '@lucide/svelte/icons/image-up'
  import History from '@lucide/svelte/icons/history'
  import { navigate } from '$lib/navigation/router.svelte'
  import Languages from '@lucide/svelte/icons/languages'
  import Avatar from '$lib/features/profile/components/Avatar.svelte'
  import AvatarDialog from '$lib/features/profile/components/AvatarDialog.svelte'
  import { logout } from '$lib/features/auth/auth'
  import { loadProfile, profile } from '$lib/features/profile/profile.svelte'
  import { session } from '$lib/resources/session.svelte'
  import { toast } from 'svelte-sonner'
  import { LOCALES, errorMessage, i18n, setLocale, t, type Locale } from '$lib/i18n/index.svelte'

  let { open = $bindable(false) }: { open?: boolean } = $props()

  // The chip shows a name, as the reference does: the part of the email
  // before the @. The full address is in the menu and on hover.
  const displayName = $derived((session.email ?? '').split('@')[0] ?? '')

  let photoOpen = $state(false)

  // One load per session.
  $effect(() => {
    if (session.email && !profile.loaded) loadProfile()
  })

  async function changeLocale(locale: Locale) {
    try {
      await setLocale(locale)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- The account chip (D98): photo or initials, who is signed in, settings. -->
      <button
        {...props}
        class="flex h-11 min-w-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1 text-left whitespace-nowrap transition-colors hover:bg-accent aria-expanded:bg-accent"
        aria-label={t('shell.account.label')}
      >
        <Avatar class="size-8 text-sm" />
        <span class="hidden min-w-0 max-w-32 flex-1 flex-col leading-tight xl:flex">
          <span class="truncate text-sm font-semibold" title={session.email}>{displayName}</span>
          <span class="truncate text-xs text-muted-foreground">{t('shell.account.role')}</span>
        </span>
        <ChevronDown class="hidden size-3.5 shrink-0 text-muted-foreground xl:block" aria-hidden="true" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" class="min-w-64">
    <div class="flex items-center gap-3 px-2 py-2">
      <Avatar class="size-9 text-sm" />
      <div class="min-w-0">
        <p class="text-xs text-muted-foreground">{t('shell.account.signedInAs')}</p>
        <p class="text-sm font-medium break-all">{session.email}</p>
      </div>
    </div>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onclick={() => (photoOpen = true)}>
      <ImageUp />{profile.avatar === null ? t('shell.account.addPhoto') : t('shell.account.changePhoto')}
    </DropdownMenu.Item>
    <DropdownMenu.Item onclick={() => navigate('/updates')}><History />{t('shell.pages.updates')}</DropdownMenu.Item>
    <DropdownMenu.Item onclick={toggleMode}>
      {#if (mode.current === 'dark')}<Sun />{t('shell.account.lightTheme')}{/if}
      {#if !(mode.current === 'dark')}<Moon />{t('shell.account.darkTheme')}{/if}
    </DropdownMenu.Item>
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <Languages />{t('shell.account.language')}
        <span class="ml-auto pl-3 text-xs text-muted-foreground">{t(`shell.languages.${i18n.locale}`)}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="min-w-40">
        <DropdownMenu.RadioGroup value={i18n.locale} onValueChange={(value) => changeLocale(value as Locale)}>
          {#each LOCALES as locale (locale)}
            <!-- Each language names itself, so it can be found from either one. -->
            <DropdownMenu.RadioItem value={locale} lang={locale}>{t(`shell.languages.${locale}`)}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onclick={logout}><LogOut />{t('shell.account.signOut')}</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<AvatarDialog bind:open={photoOpen} />
