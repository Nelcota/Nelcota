<script lang="ts">
  import { mode, toggleMode } from 'mode-watcher'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import LayoutGrid from '@lucide/svelte/icons/layout-grid'
  import Boxes from '@lucide/svelte/icons/boxes'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import ArrowUpCircle from '@lucide/svelte/icons/arrow-up-circle'
  import Sun from '@lucide/svelte/icons/sun'
  import Moon from '@lucide/svelte/icons/moon'
  import Logo from './Logo.svelte'
  import { href } from '$lib/navigation/router.svelte'
  import { isActive } from '$lib/shell/nav'
  import { t } from '$lib/i18n/index.svelte'

  const links = [
    { path: '/', title: 'shell.pages.overview', icon: LayoutGrid },
    { path: '/projects', title: 'shell.pages.projects', icon: Boxes },
    { path: '/guides', title: 'shell.pages.guides', icon: BookOpen },
  ] as const
</script>

<aside class="panel-rail" aria-label="Nelcota">
  <a href={href('/')} class="mb-5 grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10" aria-label="Nelcota"><Logo mark /></a>
  <nav class="grid gap-2" aria-label={t('shell.nav.shortcuts')}>
    {#each links as item (item.path)}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <a {...props} href={href(item.path)} class={['panel-rail-link', isActive(item.path) && 'is-active']} aria-label={t(item.title)} aria-current={isActive(item.path) ? 'page' : undefined}>
              <item.icon class="size-5" strokeWidth={1.6} aria-hidden="true" />
            </a>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">{t(item.title)}</Tooltip.Content>
      </Tooltip.Root>
    {/each}
  </nav>
  <div class="mt-auto grid gap-2 pt-5">
    <a href={href('/updates')} class={['panel-rail-link panel-updates-link', isActive('/updates') && 'is-active']} aria-label={t('shell.pages.updates')} title={t('shell.pages.updates')}><ArrowUpCircle class="size-5" strokeWidth={1.6} aria-hidden="true" /></a>
    <button type="button" class="panel-rail-link" onclick={toggleMode} aria-label={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')} title={mode.current === 'dark' ? t('shell.account.lightTheme') : t('shell.account.darkTheme')}>
      {#if mode.current === 'dark'}<Sun class="size-5" strokeWidth={1.6} aria-hidden="true" />{/if}
      {#if mode.current !== 'dark'}<Moon class="size-5" strokeWidth={1.6} aria-hidden="true" />{/if}
    </button>
  </div>
</aside>
