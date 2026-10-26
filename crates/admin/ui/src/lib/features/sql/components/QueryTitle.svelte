<script lang="ts">
  import { tick } from 'svelte'
  import { t } from '$lib/i18n/index.svelte'

  // The open query's name. A saved one is renamed in place; clicking an
  // unsaved one asks for a name to save it under.
  let {
    name,
    fallback,
    dirty,
    onrename,
    onsave,
  }: {
    /** Saved name, or `null` for an unsaved query. */
    name: string | null
    /** Name shown for an unsaved query. */
    fallback: string
    dirty: boolean
    onrename: (name: string) => void
    onsave: () => void
  } = $props()

  let editing = $state(false)
  let value = $state('')
  let input = $state<HTMLInputElement>()

  async function start() {
    if (name === null) return onsave()
    value = name
    editing = true
    await tick()
    input?.select()
  }

  function commit() {
    // Removing the focused input fires blur in Chromium: after Escape (or
    // Enter) that blur must not save again.
    if (!editing) return
    const next = value.trim()
    editing = false
    if (name !== null && next && next !== name) onrename(next)
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') { commit(); return }
    if (event.key === 'Escape') editing = false
  }
</script>

<div class="flex min-w-0 items-center gap-2">
  {#if (editing)}
    <input
      bind:this={input}
      bind:value
      onblur={commit}
      {onkeydown}
      maxlength="80"
      aria-label={t('sql.dialog.renameTitle')}
      class="h-8 w-64 max-w-full rounded-md border bg-background px-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  {/if}
  {#if !(editing)}
    <h1 class="min-w-0">
      <button
        type="button"
        class="max-w-full cursor-text truncate rounded-md px-1.5 py-1 text-left text-sm font-semibold hover:bg-accent"
        title={name === null ? t('sql.editor.saveHint') : t('sql.editor.renameHint')}
        onclick={start}>{name ?? fallback}</button
      >
    </h1>
  {/if}
  {#if dirty && !editing}
    <!-- Phones keep the room for the name: a dot stands in for the words. -->
    <span class="shrink-0 text-xs text-muted-foreground" title={t('sql.editor.unsavedTitle')}
      ><span class="block size-1.5 rounded-full bg-muted-foreground sm:hidden" aria-hidden="true"></span><span class="max-sm:sr-only">{t('sql.editor.unsaved')}</span></span
    >
  {/if}
</div>
