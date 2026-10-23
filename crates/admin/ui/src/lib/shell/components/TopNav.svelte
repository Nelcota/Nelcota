<script lang="ts">
  import type { Snippet } from 'svelte'
  import * as Sheet from '$lib/components/ui/sheet'
  import Menu from '@lucide/svelte/icons/menu'
  import Search from '@lucide/svelte/icons/search'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import ProjectSwitcher from '$lib/features/projects/components/ProjectSwitcher.svelte'
  import AccountMenu from './AccountMenu.svelte'
  import WorkspaceRail from './WorkspaceRail.svelte'
  import WorkspaceLinks from './WorkspaceLinks.svelte'
  import { palette } from '$lib/shell/palette.svelte'
  import { href, route } from '$lib/navigation/router.svelte'
  import { crumbsFor } from '$lib/shell/titles'
  import { t } from '$lib/i18n/index.svelte'

  let { children }: { children: Snippet } = $props()
  let mobileOpen = $state(false)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const crumbs = $derived(crumbsFor(route.path))
</script>

<div class="panel-workspace">
  <WorkspaceRail />
  <div class="panel-body">
    <header class="panel-topbar">
      <div class="flex min-w-0 flex-1 items-center gap-2 md:flex-none">
        <button type="button" class="panel-icon-button panel-menu-trigger" onclick={() => (mobileOpen = true)} aria-label={t('shell.nav.menu')}>
          <Menu class="size-[18px]" aria-hidden="true" />
        </button>
        <div class="min-w-0 flex-1 md:w-52"><ProjectSwitcher /></div>
      </div>
      <nav aria-label={t('shell.nav.breadcrumb')} class="hidden min-w-0 flex-1 md:block">
        <ol class="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
          {#each crumbs as crumb, index (`${index}-${crumb.label}`)}
            <li class="flex min-w-0 items-center gap-3">
              <ChevronRight class="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              {#if crumb.path}<a class="truncate hover:text-foreground" href={href(crumb.path)}>{crumb.label}</a>{/if}
              {#if !crumb.path}<span class="truncate text-foreground" aria-current="page">{crumb.label}</span>{/if}
            </li>
          {/each}
        </ol>
      </nav>
      <div class="flex shrink-0 items-center gap-2">
        <button type="button" onclick={() => (palette.open = true)} class="panel-search" aria-label={`${t('shell.topbar.searchLabel')} (${isMac ? '⌘' : 'Ctrl'} K)`} title={`${t('shell.topbar.searchLabel')} (${isMac ? '⌘' : 'Ctrl'} K)`}>
          <Search class="size-4 shrink-0" aria-hidden="true" />
          <span class="hidden lg:block">{t('shell.topbar.searchLabel')}…</span>
          <kbd class="ml-auto hidden text-xs text-muted-foreground/75 lg:block">{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <AccountMenu />
      </div>
    </header>
    <div class="panel-content">
      <aside class="panel-sidebar" aria-label={t('shell.nav.main')}>
        <p class="px-3 pb-3 text-xs font-medium text-muted-foreground">{t('shell.nav.workspace')}</p>
        <WorkspaceLinks />
      </aside>
      {@render children()}
    </div>
  </div>
</div>

<Sheet.Root bind:open={mobileOpen}>
  <Sheet.Content side="left" class="w-72 gap-0 p-0">
    <Sheet.Title class="sr-only">{t('shell.nav.main')}</Sheet.Title>
    <div class="border-b p-4 pr-12"><span class="text-sm font-semibold">Nelcota</span></div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3"><WorkspaceLinks close={() => (mobileOpen = false)} /></div>
  </Sheet.Content>
</Sheet.Root>
