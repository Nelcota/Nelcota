<script lang="ts">
  import { onMount } from 'svelte'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Download from '@lucide/svelte/icons/download'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { downloadText } from '$lib/browser/download'
  import { errorMessage, i18n, t } from '$lib/i18n/index.svelte'
  import { isOpenApiDocument, operations, type OpenApiDocument } from './openapi'
  import { translateOpenApi } from './openapi-prose'

  const resource = new RemoteResource<OpenApiDocument>()
  let frame = $state<HTMLIFrameElement>()
  function sendDocument() {
    if (!resource.data) return
    const source = $state.snapshot(resource.data as unknown) as OpenApiDocument
    frame?.contentWindow?.postMessage({ type: 'nelcota:openapi', document: translateOpenApi(source, i18n.locale), dark: document.documentElement.classList.contains('dark'), locale: i18n.locale }, location.origin)
  }
  $effect(() => { if (resource.data) sendDocument() })

  async function load() {
    await resource.load(async signal => {
      const response = await fetch('/rest/v1/', { signal, headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store' })
      if (!response.ok) throw new Error(t('guides.openapi.unavailable'))
      const data: unknown = await response.json()
      if (!isOpenApiDocument(data)) throw new Error(t('guides.openapi.invalid'))
      return data
    })
  }
  onMount(() => {
    void load()
    const observer = new MutationObserver(sendDocument)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => { observer.disconnect(); resource.cancel() }
  })
</script>

<div class="grid min-w-0 gap-5">
  <p class="rounded-2xl bg-well p-4 text-sm leading-relaxed text-muted-foreground">{t('guides.openapi.hint')}</p>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" onclick={load} disabled={resource.loading}><RefreshCw />{t('guides.openapi.reload')}</Button>
    {#if resource.data}<Button variant="outline" size="sm" onclick={() => downloadText('openapi.json', JSON.stringify(resource.data, null, 2), 'application/json')}><Download />{t('guides.openapi.download')}</Button><Badge variant="secondary">OpenAPI {resource.data.openapi}</Badge>{/if}
  </div>
  {#if resource.error}<LoadError message={errorMessage(resource.error)} onretry={load} busy={resource.loading} />{/if}
  {#if (resource.loading)}<Skeleton class="h-48 rounded-2xl" />
  {/if}
  {#if !(resource.loading) && (resource.data)}
    {#if (operations(resource.data).length)}
      <iframe bind:this={frame} src="/admin/assets/reference.html" title={t('guides.entries.openapi.title')} onload={sendDocument} class="h-[75dvh] min-h-96 w-full rounded-xl border"></iframe>
    {/if}
    {#if !(operations(resource.data).length)}
      <EmptyState icon={Rows3} title={t('guides.openapi.empty')} description={t('guides.openapi.emptyHint')} />
    {/if}
  {/if}
</div>
