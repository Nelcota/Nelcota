import type { ColumnInfo } from '$lib/shared/schema/ddl'

// Common owner column names. The Portuguese ones are kept on purpose: they
// match columns in users' own databases, not text of this codebase.
const OWNER_NAMES = ['user_id', 'usuario_id', 'dono', 'dono_id', 'owner', 'owner_id', 'autor_id', 'criado_por', 'author_id', 'created_by']

/** Column most likely to hold the owner: a uuid with a known name, else the first uuid that is not the PK. */
export function guessOwnerColumn(columns: readonly ColumnInfo[]): string {
  const uuids = columns.filter((c) => c.data_type === 'uuid')
  return (
    uuids.find((c) => OWNER_NAMES.includes(c.name.toLowerCase()))?.name ??
    uuids.find((c) => !c.primary_key)?.name ??
    'user_id'
  )
}
