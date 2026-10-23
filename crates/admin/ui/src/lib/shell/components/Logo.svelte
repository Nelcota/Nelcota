<script lang="ts">
  import logoBlack from '../../../assets/brand/nelcota-logo-black.svg'
  import logoWhite from '../../../assets/brand/nelcota-logo-white.svg'
  import symbolBlack from '../../../assets/brand/nelcota-symbol-black.svg'
  import symbolWhite from '../../../assets/brand/nelcota-symbol-white.svg'

  let {
    class: className = '',
    mark = false,
    size = 'md',
    decorative = false,
  }: { class?: string; mark?: boolean; size?: 'md' | 'lg' | 'xl'; decorative?: boolean } = $props()

  const dimensions = $derived(mark
    ? (size === 'xl' ? 'size-16' : size === 'lg' ? 'size-12' : 'size-10')
    : (size === 'xl' ? 'w-80 h-auto' : size === 'lg' ? 'w-72 h-auto' : 'w-60 h-auto'))
</script>

<span class={['inline-flex shrink-0 items-center', mark ? 'p-2.5' : 'p-1', className]}>
  <img src={mark ? symbolBlack : logoBlack} alt={decorative ? '' : 'Nelcota'} width={mark ? 594 : 2048} height={mark ? 542 : 768} class={['block select-none object-contain dark:hidden', dimensions]} draggable="false" />
  <img src={mark ? symbolWhite : logoWhite} alt={decorative ? '' : 'Nelcota'} width={mark ? 594 : 2048} height={mark ? 542 : 768} class={['hidden select-none object-contain dark:block', dimensions]} draggable="false" />
</span>
