import { parsePage } from '$lib/navigation/pagination'

export interface TableView {
  page: number
  size: string
  sort: { column: string; desc: boolean } | null
}

const SIZES = ['25', '50', '100', '500']

/** UI parameters are distinct from REST-style column filters. */
export function parseTableView(query: URLSearchParams): TableView {
  const size = query.get('_size') ?? '50'
  const column = query.get('_sort')
  return {
    page: parsePage(query.get('_page')),
    size: SIZES.includes(size) ? size : '50',
    sort: column ? { column, desc: query.get('_desc') === 'true' } : null,
  }
}

export function tableViewSearch(query: URLSearchParams, patch: Partial<TableView>): string {
  const params = new URLSearchParams(query)
  if (patch.page !== undefined) {
    params.delete('_page')
    if (Number.isSafeInteger(patch.page) && patch.page > 0) params.set('_page', String(patch.page))
  }
  if (patch.size !== undefined) {
    params.delete('_size')
    if (patch.size !== '50' && SIZES.includes(patch.size)) params.set('_size', patch.size)
  }
  if (patch.sort !== undefined) {
    params.delete('_sort')
    params.delete('_desc')
    if (patch.sort) {
      params.set('_sort', patch.sort.column)
      if (patch.sort.desc) params.set('_desc', 'true')
    }
  }
  return params.toString()
}
