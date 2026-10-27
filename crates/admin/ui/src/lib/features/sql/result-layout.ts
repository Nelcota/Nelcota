// Layout of SQL results. Rows are virtualized, so the table cannot size its
// columns from the rows in the DOM: widths come from all the values instead.

/** Longer values are truncated anyway (the cell caps at MAX_CELL_WIDTH, about 53ch). */
export const MAX_COLUMN_CHARS = 64
const MIN_COLUMN_CHARS = 4
const NULL_LABEL_CHARS = 4
/** Values longer than this, or with line breaks, get a button that opens the full text. */
export const DETAIL_TEXT_LIMIT = 80
const MAX_CELL_WIDTH = '24rem'
/** px-3 on both sides plus the cell's right border. */
const CELL_PADDING = '1.5rem + 1px'
/** The size-7 details button and the gap-2 before it. */
const DETAIL_BUTTON_WIDTH = '2.25rem'

export interface ColumnWidth {
  /** Characters of the monospace font: the header or the longest value. */
  chars: number
  /** Some value in the column shows the details button. */
  detail: boolean
}

export const needsDetail = (cell: string | null): cell is string =>
  cell !== null && (cell.length > DETAIL_TEXT_LIMIT || cell.includes('\n'))

export function columnWidths(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): ColumnWidth[] {
  return columns.map((column, columnIndex) => {
    let widest = Math.max(MIN_COLUMN_CHARS, column.length)
    let detail = false
    for (const row of rows) {
      if (widest >= MAX_COLUMN_CHARS && detail) break
      const cell = row[columnIndex] ?? null
      const length = cell === null ? NULL_LABEL_CHARS : cell.length
      if (length > widest) widest = length
      if (needsDetail(cell)) detail = true
    }
    return { chars: Math.min(widest, MAX_COLUMN_CHARS), detail }
  })
}

/** CSS width of a column (resolve `ch` in the cells' monospace font). */
export function columnWidthCss(width: ColumnWidth): string {
  const button = width.detail ? ` + ${DETAIL_BUTTON_WIDTH}` : ''
  return `min(${MAX_CELL_WIDTH}, calc(${width.chars}ch + ${CELL_PADDING}${button}))`
}
