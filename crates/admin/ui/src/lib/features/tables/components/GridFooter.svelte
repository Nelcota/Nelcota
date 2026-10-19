<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Select from '$lib/components/ui/select'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import ChevronsLeft from '@lucide/svelte/icons/chevrons-left'
  import ChevronsRight from '@lucide/svelte/icons/chevrons-right'
  import { pageInfo } from '$lib/features/tables/grid'
  import type { TableData } from '$lib/contracts/types'
  import { intlLocale, t } from '$lib/i18n/index.svelte'

  let {
    data,
    page,
    size,
    disabled = false,
    onpage,
    onsize,
  }: { data: TableData; page: number; size: string; disabled?: boolean; onpage: (page: number) => void; onsize: (size: string) => void } = $props()

  const fmt = $derived(new Intl.NumberFormat(intlLocale()))
  const info = $derived(pageInfo(data.page, data.size, data.rows.length, data.total, data.total_exact))
  const totalLabel = $derived(
    data.total === null ? null : `${data.total_exact ? '' : '~'}${fmt.format(data.total)}`,
  )
</script>

<footer class="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t bg-card px-4 py-2 text-xs text-muted-foreground">
  <span class="tabular-nums" aria-live="polite">
    {#if (info.to === 0)}{t('tables.footer.noRows')}
    {/if}
    {#if !(info.to === 0)}<span class="font-medium text-foreground">{fmt.format(info.from)}–{fmt.format(info.to)}</span>
      {#if totalLabel}{t('tables.footer.of', { total: totalLabel })}{/if}
      {t('tables.footer.rows', { count: data.total ?? info.to })}{/if}
  </span>
  <span class="hidden items-center gap-1 xl:inline-flex">
    {data.table.editable ? t('tables.footer.hintsEditable') : t('tables.footer.hints')}
  </span>
  <!-- Phones: first/last page go (prev/next remain), so the row never clips. -->
  <div class="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
    <span class="mr-1 hidden sm:inline">{t('tables.footer.perPage')}</span>
    <Select.Root type="single" value={size} onValueChange={onsize} {disabled}>
      <Select.Trigger size="sm" class="w-20" aria-label={t('tables.footer.rowsPerPage')}>{size}</Select.Trigger>
      <Select.Content>
        {#each ['25', '50', '100', '500'] as option (option)}
          <Select.Item value={option}>{option}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <span class="px-1 font-medium whitespace-nowrap text-foreground tabular-nums sm:px-2">
      {info.pageCount
        ? t('tables.footer.pageOf', { page: fmt.format(data.page + 1), count: fmt.format(info.pageCount) })
        : t('tables.footer.page', { page: fmt.format(data.page + 1) })}
    </span>
    <Button variant="outline" size="icon-sm" class="max-sm:hidden" disabled={disabled || page === 0} onclick={() => onpage(0)} aria-label={t('tables.footer.first')}>
      <ChevronsLeft />
    </Button>
    <Button variant="outline" size="icon-sm" disabled={disabled || page === 0} onclick={() => onpage(page - 1)} aria-label={t('tables.footer.previous')}>
      <ChevronLeft />
    </Button>
    <Button variant="outline" size="icon-sm" disabled={disabled || !data.has_next} onclick={() => onpage(page + 1)} aria-label={t('tables.footer.next')}>
      <ChevronRight />
    </Button>
    <Button
      variant="outline"
      size="icon-sm"
      class="max-sm:hidden"
      disabled={disabled || info.lastPage === null || page >= info.lastPage}
      onclick={() => info.lastPage !== null && onpage(info.lastPage)}
      aria-label={t('tables.footer.last')}
      title={info.lastPage === null ? t('tables.footer.estimated') : undefined}
    >
      <ChevronsRight />
    </Button>
  </div>
</footer>
