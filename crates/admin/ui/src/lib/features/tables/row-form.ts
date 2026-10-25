// Rules of the row form (insert/edit), kept apart from the component so they
// can be tested without mounting the interface.

import { columnKind } from './grid'
import type { Column, RowData } from '$lib/contracts/types'

export interface FieldState {
  value: string
  isNull: boolean
}

/** Initial field state: the row's values, or empty (insert). */
export function initialFields(columns: readonly Column[], row: RowData | null): Record<string, FieldState> {
  return Object.fromEntries(
    columns.map((c) => {
      const value = row ? row[c.name] : null
      return [c.name, { value: value ?? '', isNull: row ? value === null : false }]
    }),
  )
}

/** What keeps a field from being saved; the form shows `tables.row.problems.<problem>`. */
export type FieldProblem = 'invalidJson' | 'required'

/** Problem that keeps the field from being saved, or `null`. */
export function fieldProblem(column: Column, field: FieldState, inserting: boolean): FieldProblem | null {
  if (field.isNull) return null
  if (columnKind(column) === 'json' && field.value.trim() !== '') {
    try {
      JSON.parse(field.value)
    } catch {
      return 'invalidJson'
    }
  }
  // On insert an empty field means DEFAULT; without DEFAULT and NULL it is required.
  if (inserting && field.value === '' && !column.nullable && !column.has_default) return 'required'
  return null
}

/**
 * Values to send. Edit: only what differs from the original row (typing and
 * going back to the old value does not count). Insert: an empty field is left
 * out (the DEFAULT applies), unless NULL is ticked.
 */
export function rowPayload(
  columns: readonly Column[],
  fields: Record<string, FieldState>,
  original: RowData | null,
): Record<string, string | null> {
  const values = new Map<string, string | null>()
  for (const c of columns) {
    if (c.generated) continue
    const f = fields[c.name]
    if (!f) continue
    const value = f.isNull ? null : f.value
    if (original) {
      if (value !== original[c.name]) values.set(c.name, value)
      continue
    }
    if (f.isNull) {
      values.set(c.name, null)
      continue
    }
    if (f.value !== '') {
      values.set(c.name, f.value)
    }
  }
  return Object.fromEntries(values)
}
