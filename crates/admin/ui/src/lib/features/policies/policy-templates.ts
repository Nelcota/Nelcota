// Most common policy templates. The "owner" ones use the column holding the
// user (uuid), compared with auth.uid(). Label, description and the default
// policy name come from the i18n catalog (`policies.templates.<id>`), so they
// follow the panel language.

import type { ColumnInfo, PolicyDef } from '$lib/shared/schema/ddl'
import { t } from '$lib/i18n/index.svelte'
import { quoteIfNeeded } from '$lib/shared/schema/ident'
export { quoteIfNeeded } from '$lib/shared/schema/ident'

export type PolicyTemplateId =
  | 'publicRead'
  | 'signedInRead'
  | 'ownerSelect'
  | 'ownerInsert'
  | 'ownerUpdate'
  | 'ownerDelete'
  | 'ownerAll'

export interface PolicyTemplate {
  id: PolicyTemplateId
  build: (ownerColumn: string) => Omit<PolicyDef, 'permissive' | 'name'>
}

const owner = (column: string) => `${quoteIfNeeded(column)} = auth.uid()`

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  {
    id: 'publicRead',
    build: () => ({ command: 'select', roles: ['anon', 'authenticated'], using: 'true', check: null }),
  },
  {
    id: 'signedInRead',
    build: () => ({ command: 'select', roles: ['authenticated'], using: 'true', check: null }),
  },
  {
    id: 'ownerSelect',
    build: (column) => ({ command: 'select', roles: ['authenticated'], using: owner(column), check: null }),
  },
  {
    id: 'ownerInsert',
    build: (column) => ({ command: 'insert', roles: ['authenticated'], using: null, check: owner(column) }),
  },
  {
    id: 'ownerUpdate',
    build: (column) => ({ command: 'update', roles: ['authenticated'], using: owner(column), check: owner(column) }),
  },
  {
    id: 'ownerDelete',
    build: (column) => ({ command: 'delete', roles: ['authenticated'], using: owner(column), check: null }),
  },
  {
    id: 'ownerAll',
    build: (column) => ({ command: 'all', roles: ['authenticated'], using: owner(column), check: owner(column) }),
  },
]

/** Template label, description and default policy name in the current language. */
export const templateText = (id: PolicyTemplateId) => ({
  label: t(`policies.templates.${id}.label`),
  description: t(`policies.templates.${id}.description`),
  name: t(`policies.templates.${id}.name`),
})

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
