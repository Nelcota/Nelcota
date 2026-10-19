/** Missing dates have no label; malformed text stays visible without throwing from Intl. */
export function dateText(value: string | number | null | undefined, format: (date: Date) => string): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    if (typeof value === 'string') return value
    return '—'
  }
  return format(date)
}
