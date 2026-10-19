<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import Search from '@lucide/svelte/icons/search'
  import Mascot from '$lib/shell/components/Mascot.svelte'
  import { palette } from '$lib/shell/palette.svelte'
  import { href, route } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'
</script>

<!-- The mascot looks lost with the visitor, on a card like the rest of the panel.
     The address that failed is shown, and search is one click away. -->
<div class="mx-auto grid h-full w-full max-w-page place-items-center px-4 pt-2 pb-12 sm:px-6 lg:px-8">
  <div class="grid w-full max-w-md justify-items-center rounded-3xl bg-card px-6 pt-8 pb-10 text-center sm:px-8">
    <Mascot pose="neutral" class="size-28" />
    <p class="mt-2 font-mono text-sm text-muted-foreground">404</p>
    <h1 class="mt-1 text-2xl font-semibold tracking-tight">{t('overview.notFound.title')}</h1>
    <p class="mt-1 text-sm text-muted-foreground">{t('overview.notFound.description')}</p>
    <p class="mt-3 max-w-full truncate rounded-lg bg-well px-3 py-1 font-mono text-xs text-muted-foreground" title={route.path}>{route.path}</p>
    <div class="mt-6 flex flex-wrap justify-center gap-2">
      <Button href={href('/')}>{t('overview.notFound.back')}</Button>
      <Button variant="outline" onclick={() => (palette.open = true)}><Search data-icon="inline-start" aria-hidden="true" />{t('overview.notFound.search')}</Button>
    </div>
  </div>
</div>
