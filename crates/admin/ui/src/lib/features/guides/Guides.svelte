<script lang="ts">
  import { tick } from 'svelte'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Search from '@lucide/svelte/icons/search'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import { href, navigate, route } from '$lib/navigation/router.svelte'
  import { i18n, t } from '$lib/i18n/index.svelte'
  import { commandScore } from '$lib/shell/search'
  import { guides, guideGroups, guidePath, guideSource, guideTranslation, guideSearchText } from './content'
  import { readMarkdown } from './markdown'
  import OpenApiReference from './OpenApiReference.svelte'
  import NotFound from '$lib/shell/NotFound.svelte'

  let search = $state('')
  let article = $state<HTMLElement>()
  const path = $derived(route.path.replace(/\/$/, ''))
  const missing = $derived(path !== '/guides' && !guides.some(guide => path === guidePath(guide.id)))
  const selected = $derived(guides.find(guide => path === guidePath(guide.id)) ?? guides.find(guide => guide.id === (i18n.locale === 'pt-BR' ? 'sdk-start' : 'quickstart'))!)
  const source = $derived(guideSource(selected))
  const blocks = $derived('code' in selected ? [] : readMarkdown(source, selected.source, guideTranslation(selected, i18n.locale)))
  const headings = $derived(blocks.filter(block => block.type === 'heading'))
  const notes = $derived('versionNotes' in selected ? blocks.slice(0, selected.versionNotes) : [])
  const body = $derived(blocks.slice(notes.length))
  const visible = $derived(guides.filter(guide => commandScore(`${t(`guides.entries.${guide.id}.title`)} ${t(`guides.entries.${guide.id}.description`)} ${guideSearchText(guide, i18n.locale)}`, search) > 0))

  // Query-based section links survive the SPA router, reload and browser back.
  $effect(() => {
    const section = route.query.get('section')
    const id = selected.id
    void tick().then(() => {
      if (selected.id !== id) return
      const target = section && article ? Array.from(article.querySelectorAll<HTMLElement>('[id]')).find(element => element.id === section) : null
      if (target) { target.scrollIntoView({ block: 'start' }); return }
      document.getElementById('conteudo')?.scrollTo({ top: 0 })
    })
  })
</script>

{#if (missing)}<NotFound />{/if}
{#if !(missing)}
<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 sm:px-6 lg:px-8 [&>:first-child]:mb-0">
  <PageHeader title={t('guides.title')} description={t('guides.description')} />
  <div class="grid items-start gap-6 md:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_12rem]">
    <aside class="grid gap-4 md:sticky md:top-4">
      <SearchField bind:value={search} label={t('guides.search')} />
      <div class="md:hidden">
        <Select.Root type="single" value={selected.id} onValueChange={id => { if (id) navigate(`/guides/${id}`) }}>
          <Select.Trigger class="w-full" aria-label={t('guides.choose')}><span class="truncate">{t(`guides.entries.${selected.id}.title`)}</span></Select.Trigger>
          <Select.Content>
            {#each guideGroups as group (group)}
              <Select.Group>
                <Select.GroupHeading>{t(`guides.groups.${group}`)}</Select.GroupHeading>
                {#each visible.filter(guide => guide.group === group) as guide (guide.id)}
                  <Select.Item value={guide.id}>{t(`guides.entries.${guide.id}.title`)}</Select.Item>
                {/each}
              </Select.Group>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <nav aria-label={t('guides.navigation')} class={[search ? 'grid' : 'hidden md:grid', 'max-h-[65dvh] gap-5 overflow-y-auto pr-1']}>
        {#each guideGroups as group (group)}
          {@const entries = visible.filter(guide => guide.group === group)}
          {#if entries.length}
            <div class="grid gap-1">
              <h2 class="px-3 pb-1 text-xs font-semibold text-muted-foreground">{t(`guides.groups.${group}`)}</h2>
              {#each entries as guide (guide.id)}
                <a class={['rounded-xl px-3 py-2 text-sm transition-colors', selected.id === guide.id ? 'bg-nav-active font-medium text-nav-active-foreground' : 'text-muted-foreground hover:bg-nav hover:text-foreground']} href={href(guidePath(guide.id))} aria-current={selected.id === guide.id ? 'page' : undefined}>
                  {t(`guides.entries.${guide.id}.title`)}
                </a>
              {/each}
            </div>
          {/if}
        {/each}
        {#if !visible.length}<EmptyState icon={Search} title={t('guides.noResults')} description={t('guides.noResultsHint')} />{/if}
      </nav>
    </aside>

    <article bind:this={article} class="guide-reader grid min-w-0 gap-5 rounded-3xl bg-card p-5 sm:p-7 lg:p-8">
      <header class="grid gap-3 border-b pb-5">
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <BookOpen class="size-4" aria-hidden="true" />{t(`guides.groups.${selected.group}`)}
        </div>
        <h2 class="text-xl font-semibold tracking-tight sm:text-2xl">{t(`guides.entries.${selected.id}.title`)}</h2>
        <p class="text-sm text-muted-foreground">{t(`guides.entries.${selected.id}.description`)}</p>
        <Button variant="outline" size="sm" class="w-fit" href={href(selected.action)}>{t('guides.openPanel')}<ArrowRight data-icon="inline-end" aria-hidden="true" /></Button>
      </header>
      {#if (selected.id === 'openapi')}
        <OpenApiReference />
      {/if}
      {#if !(selected.id === 'openapi') && ('code' in selected)}
        <CodeBlock code={source} lang={selected.code} />
      {/if}
      {#if !(selected.id === 'openapi') && !('code' in selected)}
        {#if headings.length}
          <details class="rounded-2xl bg-well p-4 xl:hidden">
            <summary class="cursor-pointer text-sm font-medium">{t('guides.contents')}</summary>
            <nav class="mt-3 grid gap-2" aria-label={t('guides.contents')}>
              {#each headings.filter(heading => heading.level === 2) as heading (heading.id)}<a class="text-sm text-muted-foreground hover:text-foreground" href={href(guidePath(selected.id, heading.id))}>{heading.text}</a>{/each}
            </nav>
          </details>
        {/if}
        <div class="grid min-w-0 gap-4" lang={'language' in selected ? selected.language : i18n.locale}>
          {#if notes.length}
            <details class="rounded-2xl bg-well p-4">
              <summary class="cursor-pointer text-sm font-medium" lang={i18n.locale}>{t('guides.versionNotes')}</summary>
              {#each notes as block, index (`${selected.id}:notes:${index}`)}
                {#if block.type === 'html'}<div class="guide-prose mt-3 min-w-0">{@html block.html}</div>{/if}
              {/each}
            </details>
          {/if}
          {#each body as block, index (`${selected.id}:${index}`)}
            {#if (block.type === 'code')}
              <CodeBlock code={block.code} lang={block.lang} />
            {/if}
            {#if !(block.type === 'code') && (block.type === 'heading')}
              <svelte:element this={`h${Math.min(block.level + 1, 6)}`} id={block.id} class={['scroll-mt-6 pt-5 font-semibold', block.level === 2 ? 'text-lg' : 'text-base']}>{@html block.html}</svelte:element>
            {/if}
            {#if !(block.type === 'code') && !(block.type === 'heading')}<div class="guide-prose min-w-0">{@html block.html}</div>{/if}
          {/each}
        </div>
      {/if}
    </article>

    {#if headings.length}
      <nav class="sticky top-4 hidden max-h-[80dvh] overflow-y-auto xl:grid" aria-label={t('guides.contents')}>
        <h2 class="pb-3 text-xs font-semibold text-muted-foreground">{t('guides.contents')}</h2>
        {#each headings.filter(heading => heading.level === 2) as heading (heading.id)}
          <a class="border-l py-2 pl-3 text-xs leading-relaxed text-muted-foreground transition-colors hover:border-brand hover:text-foreground" href={href(guidePath(selected.id, heading.id))}>{heading.text}</a>
        {/each}
      </nav>
    {/if}
  </div>
</div>
{/if}

<style>
  .guide-reader :global(a:not([data-slot="button"])) { overflow-wrap: anywhere; }
  .guide-prose { font-size: 0.875rem; line-height: 1.8; color: var(--muted-foreground); }
  .guide-prose :global(p + p), .guide-prose :global(p + ul), .guide-prose :global(p + ol) { margin-top: 0.75rem; }
  .guide-prose :global(strong) { color: var(--foreground); font-weight: 600; }
  .guide-prose :global(a) { color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
  .guide-prose :global(a:hover) { text-decoration-color: var(--brand); }
  .guide-prose :global(code:not(pre code)) { border-radius: 0.3rem; background: var(--well); padding: 0.125rem 0.3rem; color: var(--foreground); font-size: 0.8em; overflow-wrap: anywhere; }
  .guide-prose :global(ul), .guide-prose :global(ol) { padding-left: 1.4rem; }
  .guide-prose :global(ul) { list-style: disc; }
  .guide-prose :global(ol) { list-style: decimal; }
  .guide-prose :global(li + li) { margin-top: 0.4rem; }
  .guide-prose :global(li > ul), .guide-prose :global(li > ol) { margin-top: 0.4rem; }
  .guide-prose :global(blockquote) { border-left: 3px solid var(--brand); padding: 0.5rem 1rem; background: var(--well); border-radius: 0 0.75rem 0.75rem 0; }
  .guide-prose :global(pre) { overflow-x: auto; border-radius: 0.75rem; background: var(--well); padding: 1rem; font-size: 0.8rem; }
  .guide-prose :global(.guide-table) { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 0.75rem; }
  .guide-prose :global(table) { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.8rem; }
  .guide-prose :global(th), .guide-prose :global(td) { padding: 0.65rem 0.8rem; vertical-align: top; min-width: 7rem; }
  .guide-prose :global(th) { background: var(--well); color: var(--foreground); font-weight: 600; }
  .guide-prose :global(tr + tr), .guide-prose :global(tbody) { border-top: 1px solid var(--border); }
  .guide-prose :global(img) { width: 100%; height: auto; border-radius: 0.75rem; }
  .guide-prose :global(hr) { margin: 1rem 0; border-color: var(--border); }
</style>
