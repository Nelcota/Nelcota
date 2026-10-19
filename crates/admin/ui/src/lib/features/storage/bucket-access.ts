// Plain-language reading of a bucket's file access rules (D93): the policies
// on storage.objects that the panel's templates create, recognized back from
// the way Postgres prints them. Anything else is a custom rule, with its SQL
// one click away.
import type { StoragePolicy } from '$lib/contracts/types'

/** The templates the server builds (`storage_access::Template`). */
export const TEMPLATES = ['public_read', 'signed_in_read', 'signed_in_upload', 'own_folder', 'own_files'] as const
export type TemplateId = (typeof TEMPLATES)[number]

export type RuleMeaning = { kind: TemplateId } | { kind: 'custom' }

/**
 * An expression without casts, parentheses, spaces or case, so the text the
 * panel sent and the text Postgres prints back compare equal.
 */
export function canonical(expression: string | null): string | null {
  if (expression === null) return null
  return expression.toLowerCase().replaceAll('::text', '').replace(/[()\s]/g, '')
}

export function describeRule(policy: StoragePolicy, bucket: string): RuleMeaning {
  if (policy.all_buckets) return { kind: 'custom' }
  const command = policy.command.toLowerCase()
  const roles = policy.roles.map((role) => role.toLowerCase())
  const signedInOnly = roles.length === 1 && roles[0] === 'authenticated'
  const everyone = roles.includes('anon') || roles.includes('public')
  const using = canonical(policy.using)
  const check = canonical(policy.check)
  const inBucket = `bucket_id='${bucket}'`
  const folder = `${inBucket}andstorage.foldernamename[1]=auth.uid`
  const owner = `${inBucket}andowner=auth.uid`

  if (command === 'select' && using === inBucket && check === null) {
    if (everyone) return { kind: 'public_read' }
    if (signedInOnly) return { kind: 'signed_in_read' }
  }
  if (signedInOnly && command === 'insert' && using === null && check === inBucket) return { kind: 'signed_in_upload' }
  if (signedInOnly && command === 'all' && using === folder && check === folder) return { kind: 'own_folder' }
  if (signedInOnly && command === 'all' && using === owner && check === owner) return { kind: 'own_files' }
  return { kind: 'custom' }
}

/** Nobody but the panel and service_role reaches the files through the API. */
export const locked = (policies: readonly StoragePolicy[], isPublic: boolean) => policies.length === 0 && !isPublic
