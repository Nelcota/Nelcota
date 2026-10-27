<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { api } from '$lib/transport/api'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import { t, errorMessage } from '$lib/i18n/index.svelte'
  import { controllerOrigin } from './controller'
  const resource = new RemoteResource<{ version: string; controller_origin: unknown }>()
  const origin = $derived(controllerOrigin(resource.data?.controller_origin))
  const version = $derived(typeof resource.data?.version === 'string' && resource.data.version !== '' ? resource.data.version : '…')
  async function load() {
    await resource.load(signal => api.get('/updates', { signal }))
  }
  onMount(() => { void load(); return () => resource.cancel() })
</script>
<div class="mx-auto w-full max-w-page px-4 py-6 sm:px-6 lg:px-8" aria-busy={resource.loading}>
  <PageHeader title={t('updates.title')} description={t('updates.subtitle')} />
  {#if resource.error}<LoadError message={errorMessage(resource.error)} onretry={load} busy={resource.loading} />{/if}
  {#if !resource.loaded || resource.loading}
    <p role="status" class="text-sm text-muted-foreground">{t('common.loading')}</p>
  {/if}
  {#if resource.loaded && !resource.loading && !resource.error}
    <div class="grid max-w-2xl gap-5 rounded-3xl bg-card p-6">
      <p>{t('updates.current')}: <strong translate="no">{version}</strong></p>
      <p class="text-sm text-muted-foreground">{t('updates.authority')}</p>
      {#if origin}<Button class="w-fit" href={`${origin}/admin/`} target="_blank" rel="noopener noreferrer">{t('updates.open')}<span class="sr-only"> {t('common.newTab')}</span><ArrowUpRight data-icon="inline-end" aria-hidden="true" /></Button>{/if}
      {#if !origin}<p role="status" class="text-sm text-muted-foreground">{t('updates.unenrolled')}</p>{/if}
    </div>
  {/if}
</div>
