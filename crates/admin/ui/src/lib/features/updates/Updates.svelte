<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/transport/api'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import { t, errorMessage } from '$lib/i18n/index.svelte'
  import { controllerOrigin } from './controller'
  let version = $state('')
  let origin = $state<string | null>(null)
  let failure = $state<unknown>(null)
  let alive = true
  onMount(() => {
    void api.get<{ version: string; controller_origin: unknown }>('/updates').then(value => { if (!alive) return; version = typeof value.version === 'string' ? value.version : ''; origin = controllerOrigin(value.controller_origin) }).catch(error => { if (alive) failure = error })
    return () => { alive = false }
  })
</script>
<div class="mx-auto w-full max-w-page px-4 py-6 sm:px-6 lg:px-8">
  <PageHeader title={t('updates.title')} description={t('updates.subtitle')} />
  {#if failure}<LoadError message={errorMessage(failure)} onretry={() => window.location.reload()} />{/if}
  {#if !failure}
    <div class="grid max-w-2xl gap-5 rounded-3xl bg-card p-6">
      <p>{t('updates.current')}: <strong translate="no">{version || '…'}</strong></p>
      <p class="text-sm text-muted-foreground">{t('updates.authority')}</p>
      {#if origin}<a class="w-fit rounded-full bg-primary px-5 py-3 font-medium text-primary-foreground" href={`${origin}/admin/`} target="_blank" rel="noopener noreferrer">{t('updates.open')}</a>{/if}
      {#if !origin}<p role="status" class="text-sm text-muted-foreground">{t('updates.unenrolled')}</p>{/if}
    </div>
  {/if}
</div>
