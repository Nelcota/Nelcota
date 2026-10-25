<script lang="ts">
  import { tick } from 'svelte'
  import { Toaster } from '$lib/components/ui/sonner'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import TopNav from './components/TopNav.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import NotFound from './NotFound.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import { session } from '$lib/resources/session.svelte'
  import { match, route } from '$lib/navigation/router.svelte'
  import { crumbsFor } from './titles'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  const path = $derived(route.path.replace(/\/$/, '') || '/')
  const structureName = $derived(match('/tables/:name/structure', path)?.name)
  const tableName = $derived(match('/tables/:name', path)?.name ?? structureName)
  const bucketName = $derived(match('/storage/:bucket', path)?.bucket)
  const guide = $derived(match('/guides/:id', path)?.id)
  const deliveryId = $derived(match('/webhooks/deliveries/:id', path)?.id)
  // Data/Structure keeps the editor mounted; a different table gets fresh state.
  const pageKey = $derived(tableName ? `/tables/${tableName}` : route.path)
  let content = $state<HTMLElement>()
  let previousPath = route.path
  const pageLabel = $derived(crumbsFor(route.path).map((crumb) => crumb.label).join(' · '))

  $effect(() => {
    const nextPath = route.path
    if (nextPath === previousPath) return
    previousPath = nextPath
    if (session.email) {
      void tick().then(() => {
        if (route.path === nextPath) content?.focus()
      })
    }
  })
</script>

{#snippet loading()}
  <p class="mx-auto w-full max-w-page px-4 pt-2 text-sm text-muted-foreground sm:px-6 lg:px-8" role="status">{t('shell.app.loading')}</p>
{/snippet}
{#snippet failed(error: unknown)}
  <!-- A page whose code could not be fetched (often a new release): the same
       card as any other load failure, and a reload to try again. -->
  <div class="mx-auto w-full max-w-page px-4 pt-2 sm:px-6 lg:px-8">
    <LoadError message={errorMessage(error)} onretry={() => window.location.reload()} />
  </div>
{/snippet}

<Toaster position="bottom-right" />
<Tooltip.Provider delayDuration={200}>
  <a
    href="#conteudo"
    class="sr-only z-50 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >{t('shell.app.skipToContent')}</a
  >
  <div class="panel-frame">
    <TopNav>
      <!-- Route and skip-link focus identify the page without framing the viewport. -->
      <!-- Keep absolute accessibility labels inside this scroll container. -->
      <!-- The page is a keyboard scroll target even when it has no controls. -->
      <main bind:this={content} id="conteudo" tabindex="0" aria-label={pageLabel} class="relative min-h-0 min-w-0 flex-1 overflow-auto focus-visible:-outline-offset-2">
        {#key pageKey}
          {#if path === '/updates'}
            {#await import('$lib/features/updates/Updates.svelte')}{@render loading()}{:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if (path === '/')}
            {#await import('$lib/features/overview/Overview.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && (path === '/tables' || tableName)}
            {#await import('$lib/features/tables/TableEditor.svelte')}
              {@render loading()}
            {:then m}<m.default name={tableName} view={structureName ? 'structure' : 'data'} />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && (path === '/sql')}
            {#await import('$lib/features/sql/SqlEditor.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && (path === '/migrations')}
            {#await import('$lib/features/migrations/Migrations.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && (path === '/users')}
            {#await import('$lib/features/users/Users.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && (path === '/sign-in')}
            {#await import('$lib/features/sign-in/SignIn.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && (path === '/storage')}
            {#await import('$lib/features/storage/Storage.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && (bucketName)}
            {#await import('$lib/features/storage/StorageBucket.svelte')}
              {@render loading()}
            {:then m}<m.default bucket={bucketName} />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && (path === '/policies')}
            {#await import('$lib/features/policies/Policies.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && (path === '/webhooks')}
            {#await import('$lib/features/webhooks/Webhooks.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && !(path === '/webhooks') && (deliveryId)}
            {#await import('$lib/features/webhooks/DeliveryDetail.svelte')}
              {@render loading()}
            {:then m}<m.default id={deliveryId} />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && !(path === '/webhooks') && !(deliveryId) && (path === '/projects')}
            {#await import('$lib/features/projects/Projects.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && !(path === '/webhooks') && !(deliveryId) && !(path === '/projects') && (path === '/connect')}
            {#await import('$lib/features/api/ApiPage.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && !(path === '/webhooks') && !(deliveryId) && !(path === '/projects') && !(path === '/connect') && (path === '/guides' || guide)}
            {#await import('$lib/features/guides/Guides.svelte')}
              {@render loading()}
            {:then m}<m.default />{:catch error}{@render failed(error)}{/await}
          {/if}
          {#if !(path === '/updates') && !(path === '/') && !(path === '/tables' || tableName) && !(path === '/sql') && !(path === '/migrations') && !(path === '/users') && !(path === '/sign-in') && !(path === '/storage') && !(bucketName) && !(path === '/policies') && !(path === '/webhooks') && !(deliveryId) && !(path === '/projects') && !(path === '/connect') && !(path === '/guides' || guide)}<NotFound />{/if}
        {/key}
      </main>
    </TopNav>
  </div>
  <CommandPalette />
</Tooltip.Provider>
