<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round'
  import { onMount, untrack, tick } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Plug from '@lucide/svelte/icons/plug'
  import Globe from '@lucide/svelte/icons/globe'
  import UserRound from '@lucide/svelte/icons/user-round'
  import Server from '@lucide/svelte/icons/server'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import Plus from '@lucide/svelte/icons/plus'
  import Download from '@lucide/svelte/icons/download'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Button } from '$lib/components/ui/button'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import LangMark from '$lib/features/api/components/LangMark.svelte'
  import ServiceTokenCard from '$lib/features/api/components/ServiceTokenCard.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import { apiSectionPages } from '$lib/shell/nav'
  import { apiSectionLocation } from '$lib/navigation/api-sections.svelte'
  import { href, navigate, route } from '$lib/navigation/router.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api, enc } from '$lib/transport/api'
  import { authSnippets, sdkSetup, tableSnippets, type Lang, type Snippet } from '$lib/features/api/api-examples'
  import type { TableData, TablesResponse } from '$lib/contracts/types'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  // The panel is served from the same host as the API.
  const base = location.origin

  const tablesResource = new RemoteResource<TablesResponse>()
  const snippetsResource = new RemoteResource<Snippet[]>()
  const tables = $derived(tablesResource.data?.tables ?? [])
  const table = $derived(tables.find((item) => item.name === route.query.get('table'))?.name ?? tables.find((item) => item.kind === 'table')?.name ?? tables[0]?.name ?? '')
  // The SDK is the recommended way in; curl and plain fetch stay a click away.
  const lang = $derived<Lang>(route.query.get('lang') === 'js' ? 'js' : route.query.get('lang') === 'curl' ? 'curl' : 'ts')
  const setup = sdkSetup(base)
  const topic = $derived(route.query.get('topic') === 'auth' ? 'auth' : 'tables')
  const snippets = $derived(topic === 'auth' ? authSnippets(base) : snippetsResource.data ?? [])
  const tableError = $derived(tablesResource.error ? errorMessage(tablesResource.error) : '')
  const snippetsError = $derived(snippetsResource.error ? errorMessage(snippetsResource.error) : '')
  const tablesLoading = $derived(tablesResource.loading)
  const snippetsLoading = $derived(snippetsResource.loading)
  async function loadTables() {
    await tablesResource.load(signal => api.get<TablesResponse>('/tables', { signal }))
  }
  onMount(() => { void loadTables(); return () => tablesResource.cancel() })

  // Scroll position also selects the matching link in the workspace sidebar.
  const sections = apiSectionPages
  const apiLocation = apiSectionLocation
  onMount(() => {
    apiLocation.current = 'api-address'
    const root = document.getElementById('conteudo')
    // The last card is too short to ever reach the top: at the bottom of the page it is the current one.
    const bottom = () => !!root && root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4
    const observer = new IntersectionObserver(
      (entries) => {
        if (bottom()) return
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top) apiLocation.current = top.target.id
      },
      { root, rootMargin: '-80px 0px -55% 0px' },
    )
    for (const { section: id } of sections) {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    }
    const atBottom = () => {
      if (bottom()) apiLocation.current = sections[sections.length - 1].section
    }
    root?.addEventListener('scroll', atBottom, { passive: true })
    return () => {
      apiLocation.current = 'api-address'
      observer.disconnect()
      root?.removeEventListener('scroll', atBottom)
    }
  })

  const requestedSection = $derived(route.query.get('section'))
  $effect(() => {
    const section = requestedSection
    if (!section || !sections.some(item => item.section === section)) return
    let cancelled = false
    void tick().then(() => {
      if (cancelled) return
      document.getElementById(section)?.scrollIntoView({ block: 'start' })
      apiLocation.current = section
    })
    return () => { cancelled = true }
  })

  function choose(patch: { table?: string; lang?: Lang; topic?: 'tables' | 'auth' }) {
    const query = new URLSearchParams(route.query)
    for (const [key, value] of Object.entries(patch)) query.set(key, value)
    navigate(`/connect?${query}`)
  }

  // Examples for the chosen table, with its real columns (type, DEFAULT, generated).
  async function loadSnippets() {
    snippetsResource.clear()
    if (topic === 'auth' || !table) return
    const selectedTable = table
    await snippetsResource.load(async signal => {
      const data = await api.get<TableData>(`/tables/${enc(selectedTable)}?size=1`, { signal })
      return tableSnippets(base, selectedTable, data.table.columns.map(c => ({
        name: c.name, type: c.full_type, has_default: c.has_default, generated: c.generated, nullable: c.nullable,
      })))
    })
  }

  $effect(() => {
    void [topic, table]
    untrack(loadSnippets)
    return () => snippetsResource.cancel()
  })

  const endpoints = [
    { id: 'rest', label: 'REST', path: '/rest/v1/' },
    { id: 'auth', label: 'Auth', path: '/auth/v1/' },
    { id: 'jwks', label: 'JWKS', path: '/auth/v1/.well-known/jwks.json' },
  ] as const



  const roles = ['anon', 'authenticated', 'service_role'] as const
  const roleIcons = { anon: Globe, authenticated: UserRound, service_role: Server }

</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0">
  <PageHeader title={t('connect.title')} description={t('connect.description')}>
    {#snippet actions()}
      <Button href="#api-sdk"><Plug data-icon="inline-start" aria-hidden="true" />{t('connect.start')}</Button>
      <Button variant="outline" href={href('/guides/openapi')}>
        <BookOpen data-icon="inline-start" aria-hidden="true" />{t('connect.openapi')}
      </Button>
    {/snippet}
  </PageHeader>

  <div class="grid gap-6 *:min-w-0">
    <div class="grid min-w-0 gap-6">
      <section id="api-address" class="grid scroll-mt-20 gap-5 rounded-3xl bg-card p-6">
        <div class="grid gap-3">
          <h2 class="text-lg font-semibold">{t('connect.address')}</h2>
          <CodeBlock code={base} label={t('connect.copyAddress')} />
        </div>
        <ul class="grid gap-3 md:grid-cols-3">
          {#each endpoints as endpoint (endpoint.path)}
            <li class="grid content-start gap-1.5 rounded-2xl bg-well p-4">
              <p class="text-sm font-semibold">{endpoint.label}</p>
              <code class="text-xs break-all">{endpoint.path}</code>
              <p class="text-sm text-muted-foreground">{t(`connect.endpoints.${endpoint.id}`)}</p>
            </li>
          {/each}
        </ul>
      </section>

      <section id="api-roles" class="grid scroll-mt-20 gap-5 rounded-3xl bg-card p-6">
        <div class="grid gap-1">
          <h2 class="text-lg font-semibold">{t('connect.caller')}</h2>
          <p class="text-sm text-muted-foreground">{t('connect.callerHint')}</p>
        </div>
        <ul class="grid gap-3 md:grid-cols-3">
          {#each roles as role (role)}
            {@const Icon = roleIcons[role]}
            <li class="flex flex-col gap-3 rounded-2xl bg-well p-4">
              <div class="flex items-center gap-3">
                <span class="grid size-10 shrink-0 place-items-center rounded-full bg-card text-muted-foreground"><Icon class="size-[18px]" aria-hidden="true" /></span>
                <div class="grid min-w-0">
                  <p class="text-sm font-semibold">{t(`connect.roles.${role}.title`)}</p>
                  <code class="text-xs text-muted-foreground">{role}</code>
                </div>
              </div>
              <p class="text-sm text-muted-foreground">{t(`connect.roles.${role}.text`)}</p>
              {#if role === 'service_role'}
                <p class="mt-auto flex w-fit items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
                  <TriangleAlert class="size-3.5" aria-hidden="true" />{t('connect.neverInBrowser')}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <section id="api-sdk" class="grid scroll-mt-20 gap-5 rounded-3xl bg-card p-6">
        <div class="grid gap-1">
          <h2 class="text-lg font-semibold">{t('connect.sdk.title')}</h2>
          <p class="text-sm text-muted-foreground">
            {t('connect.sdk.text')}
            <a class="underline underline-offset-4 hover:text-foreground" href={href('/guides/sdk')}>{t('connect.sdk.docs')}</a>
          </p>
        </div>
        <ol class="grid gap-5">
          {#snippet step(n: number, title: string)}
            <span class="grid size-7 shrink-0 place-items-center rounded-full bg-well text-xs font-semibold tabular-nums">{n}</span>
            <h3 class="text-sm font-medium">{title}</h3>
          {/snippet}
          <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            {@render step(1, t('connect.sdk.install'))}
            <div class="col-start-2"><CodeBlock code={setup.install} lang="sh" /></div>
          </li>
          <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            {@render step(2, t('connect.sdk.types'))}
            <div class="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <Button variant="outline" size="sm" href={href('/api/typescript')} download="database.ts"><Download />{t('connect.downloadTypes')}</Button>
              <span>{t('connect.sdk.orCli')} <code class="text-xs text-foreground">nelcota types -o database.ts</code></span>
            </div>
          </li>
          <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            {@render step(3, t('connect.sdk.client'))}
            <div class="col-start-2"><CodeBlock code={setup.client} lang="ts" /></div>
          </li>
        </ol>
      </section>

      <section id="api-examples" class="grid scroll-mt-20 gap-5 rounded-3xl bg-card p-6">
        <h2 class="text-lg font-semibold">{t('connect.examples')}</h2>
        <div class="flex flex-wrap items-center gap-3">
          <nav class="panel-segments" aria-label={t('connect.topic')}>
            <button type="button" class="panel-segment" aria-pressed={topic === 'tables'} onclick={() => choose({ topic: 'tables' })}
              ><Rows3 class="size-4" aria-hidden="true" />{t('connect.topics.tables')}</button
            >
            <button type="button" class="panel-segment" aria-pressed={topic === 'auth'} onclick={() => choose({ topic: 'auth' })}
              ><KeyRound class="size-4" aria-hidden="true" />{t('connect.topics.auth')}</button
            >
          </nav>
          {#if topic === 'tables' && tables.length}
            <Select.Root type="single" value={table} onValueChange={(table) => choose({ table })}>
              <Select.Trigger class="w-52 max-w-full font-mono text-xs" aria-label={t('connect.table')}><span class="truncate">{table}</span></Select.Trigger>
              <Select.Content>
                <Select.Group>
                {#each tables as item (item.name)}
                  <Select.Item value={item.name} class="font-mono text-xs">{item.name}</Select.Item>
                {/each}
                </Select.Group>
              </Select.Content>
            </Select.Root>
          {/if}
          <nav class="panel-segments sm:ml-auto" aria-label={t('connect.language')}>
            <button type="button" class="panel-segment" aria-label={t('connect.sdkLabel')} aria-pressed={lang === 'ts'} onclick={() => choose({ lang: 'ts' })}
              ><LangMark lang="ts" /><span class="sm:hidden">SDK</span><span class="hidden sm:inline">{t('connect.sdkLabel')}</span></button
            >
            <button type="button" class="panel-segment" aria-pressed={lang === 'curl'} onclick={() => choose({ lang: 'curl' })}
              ><LangMark lang="curl" />curl</button
            >
            <button type="button" class="panel-segment" aria-pressed={lang === 'js'} onclick={() => choose({ lang: 'js' })}
              ><LangMark lang="js" />JavaScript</button
            >
          </nav>
        </div>

        {#if topic === 'tables' && tableError}<LoadError message={tableError} onretry={loadTables} busy={tablesLoading} />{/if}
        {#if snippetsError}<LoadError message={snippetsError} onretry={loadSnippets} busy={snippetsLoading} />{/if}
        {#if (topic === 'tables' && (tablesLoading || snippetsLoading))}<Skeleton class="h-48 rounded-2xl" />
        {/if}
        {#if !(topic === 'tables' && (tablesLoading || snippetsLoading)) && (topic === 'tables' && !tables.length && !tableError)}
          <EmptyState icon={Rows3} title={t('connect.noTables')}>{#snippet actions()}<Button href={href('/tables?create=true')}><Plus data-icon="inline-start" aria-hidden="true" />{t('tables.editor.newTable')}</Button>{/snippet}</EmptyState>
        {/if}
        {#if !(topic === 'tables' && (tablesLoading || snippetsLoading)) && !(topic === 'tables' && !tables.length && !tableError)}
          <div class="grid gap-6 *:min-w-0">
            {#each snippets as snippet (snippet.id)}
              <article class="grid gap-2 *:min-w-0">
                <div>
                  <h3 class="text-sm font-medium">{t(`connect.snippets.${snippet.id}.label`)}</h3>
                  <p class="text-sm text-muted-foreground">{t(lang === 'ts' ? `connect.snippets.${snippet.id}.sdk` : `connect.snippets.${snippet.id}.description`, snippet.params)}</p>
                </div>
                <CodeBlock code={snippet.code[lang]} lang={lang === 'curl' ? 'sh' : 'ts'} />
              </article>
            {/each}
          </div>
        {/if}
        {#if lang !== 'ts'}
          <p class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
            {t('connect.types')}
            <Button variant="outline" size="sm" href={href('/api/typescript')} download="database.ts"><Download />{t('connect.downloadTypes')}</Button>
            <span>{t('connect.sdk.orCli')} <code class="text-xs text-foreground">nelcota types -o database.ts</code></span>
          </p>
        {/if}
      </section>

      <div id="api-token" class="scroll-mt-20"><ServiceTokenCard /></div>
    </div>
  </div>
</div>
