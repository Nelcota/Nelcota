// Why an API request was refused, in plain language (D93), from what the
// server recorded: the role, the status and the error code and message.
import type { DeniedRequest } from '$lib/contracts/types'

export type BlockReason = 'token' | 'rateLimited' | 'files' | 'rls' | 'grantAnon' | 'grantUser' | 'other'

export function blockReason(request: DeniedRequest): BlockReason {
  if (request.role === 'invalid_token' || request.code === 'invalid_token') return 'token'
  if (request.status === 429 || request.code === 'rate_limited') return 'rateLimited'
  const message = request.message.toLowerCase()
  const policy = message.includes('row-level security') || message.startsWith('permission denied')
  // Files are rows of storage.objects: their rules live on the bucket page.
  if (policy && request.path.startsWith('/storage/')) return 'files'
  if (message.includes('row-level security')) return 'rls'
  if (message.startsWith('permission denied')) return request.role === 'anon' ? 'grantAnon' : 'grantUser'
  return 'other'
}

// Paths come from anyone who calls the API, so a bad escape (`%ZZ`) must not
// throw while the page renders: it is shown as sent.
const decode = (segment: string) => {
  try { return decodeURIComponent(segment) } catch { return segment }
}

/** The table (REST) or bucket (storage) a path points at, when there is one. */
export function blockTarget(path: string): { kind: 'table' | 'function' | 'bucket'; name: string } | null {
  const rpc = /^\/rest\/v1\/rpc\/([^/]+)/.exec(path)
  if (rpc) return { kind: 'function', name: decode(rpc[1]) }
  const table = /^\/rest\/v1\/([^/]+)/.exec(path)
  if (table) return { kind: 'table', name: decode(table[1]) }
  const bucket = /^\/storage\/v1\/object\/(?:(?:public|sign|list)\/)?([^/]+)/.exec(path)
  if (bucket) return { kind: 'bucket', name: decode(bucket[1]) }
  return null
}
