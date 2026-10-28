<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Boxes from '@lucide/svelte/icons/boxes'
  import ArrowUpCircle from '@lucide/svelte/icons/arrow-up-circle'
  import SidebarGroup from '$lib/components/shared/SidebarGroup.svelte'
  import { isActive, isNavActive, navLabel, navPath, navPills } from '$lib/shell/nav'
  import { href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'

  let { close }: { close?: () => void } = $props()
</script>

<nav class="grid content-start gap-1" aria-label={t('shell.nav.main')} data-panel-navigation>
  {#each navPills as item (item.path)}
    {@const active = isActive(item.path, item.also)}
    {#if item.children}
      <SidebarGroup label={t(navLabel(item))} icon={item.icon} {active}>
        {#each item.children as child (child.path)}
          {#if child.children === undefined}
            <a href={href(navPath(child))} onclick={close} aria-current={isNavActive(child) ? child.section ? 'location' : 'page' : undefined} class={['panel-nav-link panel-nav-child', isNavActive(child) && 'is-active']}>
              <child.icon class="size-4 shrink-0" strokeWidth={1.6} aria-hidden="true" /><span>{t(navLabel(child))}</span>
            </a>
          {/if}
          {#if child.children !== undefined}
            <SidebarGroup label={t(navLabel(child))} icon={child.icon} active={isActive(child.path)} nested>
              {#each child.children as grandchild (grandchild.path)}
                <a href={href(navPath(grandchild))} onclick={close} aria-current={isNavActive(grandchild) ? 'page' : undefined} class={['panel-nav-link panel-nav-child', isNavActive(grandchild) && 'is-active']}>
                  <grandchild.icon class="size-4 shrink-0" strokeWidth={1.6} aria-hidden="true" /><span>{t(navLabel(grandchild))}</span>
                </a>
              {/each}
            </SidebarGroup>
          {/if}
        {/each}
      </SidebarGroup>
    {/if}
    {#if !item.children}
      <a href={href(item.path)} onclick={close} aria-current={active ? 'page' : undefined} class={['panel-nav-link', active && 'is-active']}>
        <item.icon class="size-[17px] shrink-0" strokeWidth={1.6} aria-hidden="true" /><span class="min-w-0">{t(navLabel(item))}</span>
      </a>
    {/if}
  {/each}
  <div class="my-3 h-px bg-border" role="separator"></div>
  <a href={href('/projects')} onclick={close} aria-current={isActive('/projects') ? 'page' : undefined} class={['panel-nav-link', isActive('/projects') && 'is-active']}><Boxes class="size-[17px] shrink-0" strokeWidth={1.6} aria-hidden="true" />{t('shell.pages.projects')}</a>
  <a href={href('/updates')} onclick={close} aria-current={isActive('/updates') ? 'page' : undefined} class={['panel-nav-link', isActive('/updates') && 'is-active']}><ArrowUpCircle class="size-[17px] shrink-0" strokeWidth={1.6} aria-hidden="true" />{t('shell.pages.updates')}</a>
  <a href={href('/guides')} onclick={close} aria-current={isActive('/guides') ? 'page' : undefined} class={['panel-nav-link', isActive('/guides') && 'is-active']}><BookOpen class="size-[17px] shrink-0" strokeWidth={1.6} aria-hidden="true" />{t('shell.pages.guides')}</a>
</nav>
