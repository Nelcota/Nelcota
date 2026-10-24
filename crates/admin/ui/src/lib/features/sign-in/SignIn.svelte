<script lang="ts">
  import { onMount } from 'svelte'
  import Info from '@lucide/svelte/icons/info'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import { Button } from '$lib/components/ui/button'
  import { href } from '$lib/navigation/router.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import OptionCard from '$lib/features/sign-in/components/OptionCard.svelte'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api } from '$lib/transport/api'
  import { minutes, signInOptions } from '$lib/features/sign-in/sign-in-options'
  import type { SignIn } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'

  const resource = new RemoteResource<SignIn>()
  const settings = $derived(resource.data)
  const options = $derived(settings ? signInOptions(settings) : [])
  const enabled = $derived(options.filter((o) => o.on).length)
  const providers = $derived(settings && (settings.providers.google || settings.providers.github))
  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const session = $derived(
    settings
      ? ([
          { id: 'access', value: minutes(settings.access_ttl_secs) },
          { id: 'refresh', value: settings.refresh_ttl_days },
          { id: 'rateLimit', value: settings.rate_limit_per_minute },
        ] as const)
      : [],
  )

  async function load() {
    await resource.load((signal) => api.get<SignIn>('/sign-in', { signal }))
  }
  onMount(() => {
    void load()
    return () => resource.cancel()
  })
</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8">
  <PageHeader title={t('signIn.title')} description={t('signIn.description')}>
    {#snippet actions()}<Button variant="outline" href={href('/connect?topic=auth')}><BookOpen data-icon="inline-start" aria-hidden="true" />{t('signIn.examples')}</Button>{/snippet}
  </PageHeader>

  {#if (resource.error)}
    <LoadError message={errorMessage(resource.error)} onretry={load} busy={resource.loading} />
  {/if}
  {#if !(resource.error) && (!settings)}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each { length: 6 }, i (i)}<Skeleton class="h-48 rounded-3xl" />{/each}
    </div>
  {/if}
  {#if !(resource.error) && !(!settings)}
    <section class="grid gap-4" aria-labelledby="signin-ways">
      <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h2 id="signin-ways" class="text-lg font-semibold">{t('signIn.summary', { on: enabled, count: options.length })}</h2>
        <p class="flex items-center gap-1.5 text-sm text-muted-foreground"><Info class="size-4 shrink-0" aria-hidden="true" />{t('signIn.fromEnv')}</p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {#each options as option (option.id)}<OptionCard {option} />{/each}
      </div>
    </section>

    <section class="grid gap-4" aria-labelledby="signin-session">
      <h2 id="signin-session" class="text-lg font-semibold">{t('signIn.session.title')}</h2>
      <div class="grid gap-4 sm:grid-cols-3">
        {#each session as item (item.id)}
          <div class="grid content-start gap-1 rounded-3xl bg-card p-5">
            <p class="text-sm text-muted-foreground">{t(`signIn.session.${item.id}.label`)}</p>
            <p class="text-3xl font-semibold tracking-tight tabular-nums">
              {fmt.format(item.value)}<span class="ml-1.5 text-base font-medium text-muted-foreground">{t(`signIn.session.${item.id}.unit`, { count: item.value })}</span>
            </p>
            <p class="text-sm text-muted-foreground">{t(`signIn.session.${item.id}.hint`)}</p>
          </div>
        {/each}
      </div>
    </section>

    {#if providers}
      <section class="grid gap-4 rounded-3xl bg-card p-5" aria-labelledby="signin-providers">
        <h2 id="signin-providers" class="text-lg font-semibold">{t('signIn.providers.title')}</h2>
        {#if settings.callback_url}
          <div class="grid gap-2">
            <p class="text-sm text-muted-foreground">{t('signIn.providers.callback')}</p>
            <CodeBlock code={settings.callback_url} label={t('signIn.providers.copyCallback')} />
          </div>
        {/if}
        <div class="grid gap-2">
          <p class="text-sm text-muted-foreground">{t('signIn.providers.pages')}</p>
          {#if (settings.redirect_urls.length)}
            <ul class="flex flex-wrap gap-2">
              {#each settings.redirect_urls as url (url)}<li class="max-w-full"><code class="block rounded-lg bg-well px-3 py-1 text-xs break-all">{url}</code></li>{/each}
            </ul>
          {/if}
          {#if !(settings.redirect_urls.length)}
            <p class="text-sm text-warning">{t('signIn.providers.noPages')}</p>
          {/if}
        </div>
      </section>
    {/if}
  {/if}
</div>
