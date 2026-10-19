import { blankColumn, type ColumnDef, type CreateTable, type PolicyDef, type Privilege } from './ddl'
import { quoteIfNeeded } from './ident'

export type Audience = 'private' | 'owner' | 'signedIn' | 'everyone'
export type AccessLevel = 'read' | 'full'
export const SIMPLE_TYPES = ['text', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb'] as const
export type SimpleType = typeof SIMPLE_TYPES[number]

export function nameProblem(name: string): 'required' | 'long' | 'invalid' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'required'
  if (new TextEncoder().encode(trimmed).length > 63) return 'long'
  if (trimmed.includes('\0')) return 'invalid'
  return null
}

export function columnProblem(columns: readonly ColumnDef[], index: number) {
  const problem = nameProblem(columns[index].name)
  if (problem) return problem
  if (columns.some((column, other) => other !== index && column.name.trim() === columns[index].name.trim())) return 'duplicate'
  return null
}

export function guidedPolicy(audience: Audience, level: AccessLevel, column = 'user_id', name?: string): PolicyDef | null {
  if (audience === 'private') return null
  const read = level === 'read' || audience === 'everyone'
  const expression = audience === 'owner' ? `${quoteIfNeeded(column)} = auth.uid()` : 'true'
  return {
    name: name ?? `${audience === 'signedIn' ? 'signed_in' : audience === 'everyone' ? 'public' : 'owner'}_${read ? 'read' : 'all'}`,
    command: read ? 'select' : 'all',
    roles: audience === 'everyone' ? ['anon', 'authenticated'] : ['authenticated'],
    permissive: true,
    using: expression,
    check: read ? null : expression,
  }
}

export function uniquePolicyName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name
  let index = 2
  while (existing.includes(`${name}_${index}`)) index++
  return `${name}_${index}`
}

export function initialTable(): CreateTable {
  return {
    name: '', comment: null, rls: true,
    columns: [
      { ...blankColumn(), name: 'id', data_type: 'bigint', primary_key: true, identity: true, nullable: false },
      { ...blankColumn(), name: 'created_at', data_type: 'timestamptz', default: 'now()', nullable: false },
      blankColumn(),
    ],
    grants: [{ role: 'service_role', privileges: ['select', 'insert', 'update', 'delete'] }],
  }
}

/** Build a complete table request without mutating the draft. */
export function tableAccess(draft: CreateTable, audience: Audience, level: AccessLevel) {
  const table = structuredClone(draft)
  table.name = table.name.trim()
  table.columns.forEach(column => { column.name = column.name.trim() })
  const policy = guidedPolicy(audience, level)
  if (audience === 'owner') {
    const column = table.columns.find(column => column.name === 'user_id')
    if (column && column.data_type !== 'uuid') throw new Error('owner_column_type')
    if (column) { column.default = 'auth.uid()'; column.nullable = false }
    if (!column) table.columns.push({ ...blankColumn(), name: 'user_id', data_type: 'uuid', nullable: false, default: 'auth.uid()' })
  }
  const privileges: Privilege[] = level === 'full' && audience !== 'everyone' ? ['select', 'insert', 'update', 'delete'] : ['select']
  table.rls = true
  table.grants = [
    { role: 'anon', privileges: audience === 'everyone' ? ['select'] : [] },
    { role: 'authenticated', privileges: audience === 'private' ? [] : privileges },
    { role: 'service_role', privileges: ['select', 'insert', 'update', 'delete'] },
  ]
  return { table, policies: policy ? [policy] : [] }
}

export const automaticColumn = (column: ColumnDef) => column.name === 'id' && column.identity || column.name === 'created_at' && column.default === 'now()'
