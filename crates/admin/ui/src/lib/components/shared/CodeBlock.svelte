<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy'
  import Check from '@lucide/svelte/icons/check'
  import { t } from '$lib/i18n/index.svelte'
  import { copyText } from '$lib/browser/clipboard'
  import { highlight, type CodeLang, type Token } from '$lib/components/shared/highlight'

  let {
    code,
    label,
    wrap = false,
    lang,
  }: {
    code: string
    label?: string
    /** Colours the code; without it the text stays plain (addresses, tokens, cell values). */
    lang?: CodeLang
    /** Wraps long lines (tokens) instead of scrolling horizontally. */
    wrap?: boolean
  } = $props()

  let copied = $state(false)
  let tokens = $state<Token[] | null>(null)
  $effect(() => {
    const source = code, language = lang
    let active = true
    tokens = null
    if (language) void highlight(source, language).then(value => { if (active) tokens = value }).catch(() => {})
    return () => { active = false }
  })
  const COLOURS = {
    keyword: 'text-[var(--syntax-keyword)]',
    function: 'text-[var(--syntax-function)]',
    type: 'text-[var(--syntax-type)]',
    string: 'text-[var(--syntax-string)]',
    number: 'text-[var(--syntax-number)]',
    comment: 'text-[var(--syntax-comment)] italic',
  }

  async function copy() {
    copied = await copyText(code)
    setTimeout(() => (copied = false), 1500)
  }
</script>

<!-- min-w-0: inside grid/flex, without it a long line widens the page. -->
<div class="group relative min-w-0 rounded-xl bg-well">
  <!-- A horizontally scrolling block needs focus to scroll with the arrow keys
       (WCAG 2.1.1); hence the tabindex on a non-interactive element. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre
    tabindex={wrap ? undefined : 0}
    aria-label={wrap ? undefined : t('connect.code.label')}
    class={[
      'px-4 py-3.5 pr-14 font-mono text-xs leading-relaxed sm:text-[0.8125rem]',
      wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto',
    ]}>{#if (tokens)}{#each tokens as token, i (i)}{#if (token.kind)}<span class={COLOURS[token.kind]}>{token.text}</span>{/if}{#if !(token.kind)}{token.text}{/if}{/each}{/if}{#if !(tokens)}{code}{/if}</pre>
  <button
    type="button"
    class="absolute top-1.5 right-1.5 grid size-8 cursor-pointer place-items-center rounded-md bg-well text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    aria-label={label ?? t('common.copy')}
    onclick={copy}
  >
    {#if (copied)}<Check class="size-4 text-success" />{/if}
    {#if !(copied)}<Copy class="size-4" />{/if}
  </button>
</div>
