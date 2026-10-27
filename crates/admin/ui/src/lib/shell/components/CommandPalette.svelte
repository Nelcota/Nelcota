<script lang="ts">
  import * as Command from '$lib/components/ui/command'
  import { toggleMode } from 'mode-watcher'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import FileCode from '@lucide/svelte/icons/file-code'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import SunMoon from '@lucide/svelte/icons/sun-moon'
  import LogOut from '@lucide/svelte/icons/log-out'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import { api } from '$lib/transport/api'
  import { logout } from '$lib/features/auth/auth'
  import { navItems } from '$lib/shell/nav'
  import { t } from '$lib/i18n/index.svelte'
  import { palette } from '$lib/shell/palette.svelte'
  import { navigate } from '$lib/navigation/router.svelte'
  import { commandScore } from '$lib/shell/search'
  import { SQL_SNIPPETS } from '$lib/features/sql/sql-snippets'
  import { sqlStore } from '$lib/features/sql/sql-store.svelte'
  import type { TableSummary } from '$lib/contracts/types'

  let tables = $state<TableSummary[]>([])

  async function loadTables(signal: AbortSignal) {
    try {
      tables = (await api.get<{ tables: TableSummary[] }>('/tables', { signal })).tables
    } catch {
      // Without the list (or cancelled), the palette keeps pages and actions.
    }
  }

  // Load on mount (whoever types right after opening finds the tables) and
  // refresh on every open, since they may have changed; meanwhile the previous
  // list stays visible. Closing the palette fetches nothing.
  let mounted = false
  $effect(() => {
    if (!palette.open && mounted) return
    mounted = true
    const controller = new AbortController()
    loadTables(controller.signal)
    return () => controller.abort()
  })

  function run(action: () => void) {
    palette.open = false
    action()
  }

  function openSql(sql: string, id: string | null = null) {
    sqlStore.open(sql, id)
    navigate('/sql')
  }

  const pages = navItems

</script>

<Command.Dialog
  bind:open={palette.open}
  filter={commandScore}
  title={t('palette.title')}
  description={t('palette.description')}
  class="sm:max-w-xl"
>
  <Command.Input aria-label={t('shell.topbar.searchLabel')} placeholder={t('palette.placeholder')} />
  <Command.List aria-label={t('palette.title')} class="min-h-0 max-h-[min(60dvh,420px)] flex-1">
    <Command.Empty class="py-8 text-muted-foreground">{t('palette.empty')}</Command.Empty>

    <Command.Group heading={t('palette.groups.pages')}>
      {#each pages as page (page.path)}
        <Command.Item value={`${t('palette.keywords.page')} ${t(page.title)}`} onSelect={() => run(() => navigate(page.path))}>
          <page.icon />{t(page.title)}
        </Command.Item>
      {/each}
    </Command.Group>

    {#if tables.length}
      <Command.Group heading={t('palette.groups.tables')}>
        {#each tables as table (table.name)}
          <Command.Item
            value={`${t('palette.keywords.table')} ${table.name}`}
            onSelect={() => run(() => navigate(`/tables/${encodeURIComponent(table.name)}`))}
          >
            <Rows3 /><span class="truncate">{table.name}</span>
            {#if table.kind !== 'table'}<Command.Shortcut>{t('palette.view')}</Command.Shortcut>{/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if sqlStore.saved.length}
      <Command.Group heading={t('palette.groups.saved')}>
        {#each sqlStore.sorted as query (query.id)}
          <Command.Item value={`${t('palette.keywords.query')} ${query.name} ${query.id}`} onSelect={() => run(() => openSql(query.sql, query.id))}>
            <FileCode /><span class="truncate">{query.name}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    <Command.Group heading={t('palette.groups.templates')}>
      {#each SQL_SNIPPETS as snippet (snippet.label)}
        <Command.Item value={`${t('palette.keywords.template')} ${t(snippet.label)}`} onSelect={() => run(() => openSql(t(snippet.sql)))}>
          <Sparkles />{t(snippet.label)}
        </Command.Item>
      {/each}
    </Command.Group>

    <Command.Separator />
    <Command.Group heading={t('palette.groups.actions')}>
      <Command.Item value={t('palette.actions.themeKeywords')} onSelect={() => run(toggleMode)}>
        <SunMoon />{t('palette.actions.theme')}
      </Command.Item>
      <Command.Item value={t('palette.actions.docsKeywords')} onSelect={() => run(() => navigate('/guides/openapi'))}>
        <BookOpen />{t('palette.actions.docs')}
      </Command.Item>
      <Command.Item value={t('palette.actions.signOutKeywords')} onSelect={() => run(logout)}>
        <LogOut />{t('palette.actions.signOut')}
      </Command.Item>
    </Command.Group>
  </Command.List>
  <!-- The keys, for whoever opened it with the mouse; phones have none. -->
  <p class="hidden items-center gap-4 border-t px-4 py-2.5 text-xs text-muted-foreground sm:flex" aria-hidden="true">
    <span class="flex items-center gap-1.5">{@render key('↑')}{@render key('↓')}{t('palette.hints.move')}</span>
    <span class="flex items-center gap-1.5">{@render key('Enter')}{t('palette.hints.open')}</span>
    <span class="flex items-center gap-1.5">{@render key('Esc')}{t('palette.hints.close')}</span>
  </p>
</Command.Dialog>

{#snippet key(label: string)}
  <kbd class="grid h-5 min-w-5 place-items-center rounded-md border bg-well px-1 font-sans text-[0.6875rem] font-medium text-foreground">{label}</kbd>
{/snippet}
