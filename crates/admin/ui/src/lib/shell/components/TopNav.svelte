<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import Menu from '@lucide/svelte/icons/menu'
  import Search from '@lucide/svelte/icons/search'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import ProjectSwitcher from '$lib/features/projects/components/ProjectSwitcher.svelte'
  import AccountMenu from './AccountMenu.svelte'
  import { palette } from '$lib/shell/palette.svelte'
  import { href } from '$lib/navigation/router.svelte'
  import { isActive, navPills } from '$lib/shell/nav'
  import { t } from '$lib/i18n/index.svelte'

  // Main navigation stays centred; on phones it moves into a sheet.
  let mobileOpen = $state(false)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  const pill = (active: boolean) => [
    'flex h-10 shrink-0 items-center rounded-full px-4 text-sm whitespace-nowrap transition-colors',
    active ? 'bg-nav-active font-medium text-nav-active-foreground' : 'text-muted-foreground hover:text-foreground',
  ]
</script>

{#snippet search()}
  <!-- Search everything (the command palette), with its shortcut in view so it
       does not read as one more page. -->
  <button
    type="button"
    onclick={() => (palette.open = true)}
    class="grid size-14 shrink-0 cursor-pointer place-items-center rounded-full bg-nav text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    aria-label={`${t('shell.topbar.searchLabel')} (${isMac ? '⌘' : 'Ctrl'} K)`}
    title={`${t('shell.topbar.searchLabel')} (${isMac ? '⌘' : 'Ctrl'} K)`}
  >
    <Search class="size-5" aria-hidden="true" />
  </button>
{/snippet}

{#snippet pills()}
  {#each navPills as item (item.path)}
    {@const active = isActive(item.path, item.also)}
    <a href={href(item.path)} aria-current={active ? 'page' : undefined} class={pill(active)}>{t(item.pill ?? item.title)}</a>
  {/each}
{/snippet}

<header class="shrink-0 bg-background/85 backdrop-blur">
  <div class="mx-auto w-full max-w-page px-4 py-4 sm:px-6 lg:px-8">
  <div class="grid grid-cols-[1fr_auto] items-center gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-8">
    <div class="flex min-w-0 items-center gap-2">
      <button
        type="button"
        class="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full bg-nav text-muted-foreground hover:text-foreground md:hidden"
        onclick={() => (mobileOpen = true)}
        aria-label={t('shell.nav.menu')}
      >
        <Menu class="size-5" aria-hidden="true" />
      </button>
      <div class="min-w-0 max-w-64 lg:w-14 xl:w-auto"><ProjectSwitcher /></div>
    </div>

    <nav aria-label={t('shell.nav.main')} class="hidden items-center gap-1 rounded-full bg-nav p-1.5 lg:flex">
      {@render pills()}
    </nav>

    <div class="flex min-w-0 items-center justify-end gap-2">
      <a href={href('/guides')} aria-label={t('shell.pages.guides')} title={t('shell.pages.guides')} aria-current={isActive('/guides') ? 'page' : undefined} class={['grid size-10 shrink-0 place-items-center rounded-full transition-colors sm:size-14', isActive('/guides') ? 'bg-nav-active text-nav-active-foreground' : 'bg-nav text-muted-foreground hover:bg-accent hover:text-foreground']}><BookOpen class="size-5" aria-hidden="true" /></a>
      {@render search()}
      <AccountMenu />
    </div>
  </div>

  <!-- Below lg: navigation gets a row of its own. -->
  <nav aria-label={t('shell.nav.main')} class="mt-3 hidden overflow-x-auto md:block lg:hidden">
    <div class="mx-auto flex w-max items-center gap-1 rounded-full bg-nav p-1.5">{@render pills()}</div>
  </nav>
  </div>
</header>

<Sheet.Root bind:open={mobileOpen}>
  <Sheet.Content side="left" class="w-72 gap-0 p-0">
    <Sheet.Title class="sr-only">{t('shell.nav.main')}</Sheet.Title>
    <div class="flex shrink-0 items-center gap-2 p-3 pr-12">
      <div class="min-w-0 flex-1"><ProjectSwitcher expanded /></div>
    </div>
    <nav class="grid content-start gap-1 overflow-y-auto p-3" aria-label={t('shell.nav.main')}>
      {#each navPills as item (item.path)}
        {@const active = isActive(item.path, item.also)}
        <a href={href(item.path)} onclick={() => (mobileOpen = false)} aria-current={active ? 'page' : undefined} class={[...pill(active), 'gap-3']}>
          <item.icon class="size-[18px]" strokeWidth={1.6} aria-hidden="true" />{t(item.title)}
        </a>
      {/each}
    </nav>
  </Sheet.Content>
</Sheet.Root>
