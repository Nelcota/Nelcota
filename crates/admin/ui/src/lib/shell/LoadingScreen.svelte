<script lang="ts">
  import Logo from './components/Logo.svelte'
  import { t } from '$lib/i18n/index.svelte'
</script>

<main class="flex min-h-dvh items-center justify-center bg-background px-6 py-12" aria-busy="true">
  <div class="flex w-full max-w-xs flex-col items-center gap-6 text-center">
    <Logo />
    <div class="flex flex-col items-center gap-3" role="status" aria-live="polite" aria-atomic="true">
      <span class="flex h-2 items-center gap-1.5" aria-hidden="true">
        <span class="loading-screen-dot size-1 rounded-full bg-brand"></span>
        <span class="loading-screen-dot size-1 rounded-full bg-brand"></span>
        <span class="loading-screen-dot size-1 rounded-full bg-brand"></span>
      </span>
      <p class="text-xs text-muted-foreground">{t('common.loading')}</p>
    </div>
  </div>
</main>
