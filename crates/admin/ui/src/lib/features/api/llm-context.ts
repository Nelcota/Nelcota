// Project context for AI assistants, in the spirit of llms.txt: the real API
// address and project, the schema as generated TypeScript types, the RLS
// policies and buckets, and how to use them through the SDK. Pure function:
// the page fetches the inputs. It never includes keys, passwords or tokens.
import type { PoliciesData, StorageOverview } from '$lib/contracts/types'

export interface LlmContextInput {
  /** The API address (the panel is served from the same origin). */
  origin: string
  project: string
  generatedAt: Date
  /** `database.ts` as the panel and `nelcota types` generate it. */
  types: string
  policies: PoliciesData
  storage: StorageOverview
}

/** A fenced block that a backtick run inside `code` cannot close early. */
function fence(lang: string, code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${lang}\n${code.trimEnd()}\n${ticks}`
}

const inline = (text: string) => `\`${text.replaceAll('`', "'")}\``

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${Number(size.toFixed(1))} ${units[unit]}`
}

const jsString = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

function sdkEssentials(origin: string, table: string | undefined, bucket: string | undefined): string {
  const from = `nelcota.from(${jsString(table ?? 'your_table')})`
  const files = `nelcota.storage.from(${jsString(bucket ?? 'your_bucket')})`
  return fence('ts', `import { createClient, unwrap, escapeLike } from '@nelcota/client'
import type { Database } from './database' // the schema below

export const nelcota = createClient<Database>(${jsString(origin)})

// Every call resolves to { data, error } and does not throw for HTTP or network failures.
const { data, error } = await ${from}.select('*').limit(20)
if (error) console.error(error.status, error.code, error.message)

// Filters: eq neq gt gte lt lte like ilike in is not match or and; order/range for paging.
await ${from}.select('*', { count: 'exact' }).order('id', { ascending: false }).range(0, 49)
await ${from}.select('*').ilike('name', \`*\${escapeLike(search)}*\`) // * is the wildcard

// Writes return no rows unless you ask for them with select().
const { data: created } = await ${from}.insert({ /* columns */ }).select().single()
await ${from}.update({ /* columns */ }).eq('id', id)  // update/delete require a filter
await ${from}.delete().eq('id', id)
await ${from}.upsert(rows, { onConflict: 'id' })
const result = await nelcota.rpc('function_name', { /* args */ }) // runs with the caller's role

// Auth: the browser session is persisted and refreshed automatically.
await nelcota.auth.signUp({ email, password, data: { name } }) // session is null until email confirmation, if required
await nelcota.auth.signInWithPassword({ email, password })
await nelcota.auth.signInWithOAuth({ provider: 'github', redirectTo: 'https://your.app/auth/callback' })
await nelcota.auth.handleRedirect() // on the OAuth callback page
const { data: user } = await nelcota.auth.getUser()
const stop = nelcota.auth.onChange((event, session) => { /* signed_in | signed_out | refreshed | user_updated */ })
await nelcota.auth.signOut()

// Storage: names are paths inside a bucket.
await ${files}.upload(\`\${user.id}/avatar.png\`, file, { upsert: true })
const { data: blob } = await ${files}.download(\`\${user.id}/avatar.png\`)
const { data: url } = await ${files}.createSignedUrl('path/file.pdf', 3600)
${files}.publicUrl('logo.png') // public buckets only

// Exceptions instead of { data, error }:
const rows = unwrap(await ${from}.select('*'))`)
}

function accessRules(policies: PoliciesData): string[] {
  const lines: string[] = []
  if (policies.exposed_without_rls.length) {
    lines.push(`**Warning:** RLS is off on ${policies.exposed_without_rls.map(inline).join(', ')}. Every role with a grant (including anonymous visitors) can use all their rows. Enable RLS and add policies before relying on them for private data.`, '')
  }
  if (policies.anon_functions.length) {
    lines.push(`Functions anonymous visitors can call: ${policies.anon_functions.map(inline).join(', ')}.`, '')
  }
  for (const table of policies.tables) {
    lines.push(`### ${inline(table.name)}`, `RLS: ${table.rls.label}${table.rls.forced ? ' (forced, also for the table owner)' : ''}.`)
    if (table.policies.length === 0) {
      lines.push(table.rls.enabled ? 'No policies: nobody can read or write rows through the API (only service_role).' : '')
    }
    for (const policy of table.policies) {
      const parts = [`${policy.command} for ${policy.roles.length ? policy.roles.join(', ') : 'public'}`]
      if (!policy.permissive) parts.push('restrictive')
      if (policy.using) parts.push(`using ${inline(policy.using)}`)
      if (policy.check) parts.push(`with check ${inline(policy.check)}`)
      lines.push(`- ${inline(policy.name)}: ${parts.join('; ')}`)
    }
    lines.push('')
  }
  return lines
}

function storageSection(storage: StorageOverview): string[] {
  if (!storage.enabled) return ['Storage is disabled on this server.', '']
  const lines = [`Maximum file size: ${bytes(storage.max_file_size)}.`]
  if (storage.buckets.length === 0) lines.push('There are no buckets yet.')
  for (const bucket of storage.buckets) {
    const details = [bucket.public ? 'public (anyone can download with publicUrl)' : 'private (access through RLS policies on its files)']
    if (bucket.file_size_limit !== null) details.push(`files up to ${bytes(bucket.file_size_limit)}`)
    if (bucket.allowed_mime_types?.length) details.push(`types ${bucket.allowed_mime_types.join(', ')}`)
    lines.push(`- ${inline(bucket.id)}: ${details.join('; ')}`)
  }
  lines.push('')
  return lines
}

export function llmContext(input: LlmContextInput): string {
  const { origin, project, policies, storage } = input
  const table = policies.tables[0]?.name
  const bucket = storage.enabled ? storage.buckets[0]?.id : undefined
  return [
    `# ${project}: Nelcota backend`,
    '',
    `> Context for an AI coding assistant, generated by the Nelcota admin panel for project ${inline(project)} at ${input.generatedAt.toISOString()}. It holds the API address, the database schema, the access rules and the storage buckets. It contains no keys, passwords or tokens. Regenerate it after changing the schema.`,
    '',
    '## Instructions for the assistant',
    '',
    '- Answer in the language the user writes in.',
    '- Use the `@nelcota/client` SDK with the `Database` type below. Call the HTTP API directly only when asked.',
    '- Use only the tables, columns, functions and buckets listed here. Ask before assuming anything else exists; schema changes are made with SQL migrations in the Nelcota panel or CLI.',
    '- Authorization happens in PostgreSQL (grants and row-level security), never in client code. Hiding a button is not access control: check the policies below and propose SQL policies when access must change.',
    '- Never put a `service_role` token in a browser, mobile app or public repository. It bypasses RLS and belongs only on a trusted server.',
    '',
    '## Connection',
    '',
    `- API URL: ${inline(origin)} (one address for REST, auth and storage)`,
    `- REST: ${inline(`${origin}/rest/v1/`)}; auth: ${inline(`${origin}/auth/v1/`)}; storage: ${inline(`${origin}/storage/v1/`)}; JWKS: ${inline(`${origin}/auth/v1/.well-known/jwks.json`)}`,
    `- Exposed schema: ${inline(policies.schema)}`,
    '- There is no public API key. Requests without a token run as the `anon` role; requests with a signed-in user\'s access token run as `authenticated` (and `auth.uid()` is that user in policies). `service_role` bypasses RLS.',
    '- Each request returns at most 1000 rows by default: paginate with `range()`.',
    '',
    '## Setup',
    '',
    fence('sh', 'bun add @nelcota/client   # or: npm install @nelcota/client'),
    '',
    `Save the schema below as \`src/database.ts\` (or download it from the panel: Connect → SDK, or run \`nelcota types -o src/database.ts\`). Other SDKs: \`nelcota-client\` for Rust (crates.io) and \`@nelcota/nextjs\` for the Next.js App Router (server-side sessions; the browser only gets an opaque HttpOnly cookie).`,
    '',
    '## SDK essentials',
    '',
    sdkEssentials(origin, table, bucket),
    '',
    '## Access rules (row-level security)',
    '',
    ...accessRules(policies),
    '## Storage',
    '',
    ...storageSection(storage),
    '## Database schema',
    '',
    fence('ts', input.types),
    '',
    '## Documentation',
    '',
    '- SDK guide: https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/README.md',
    '- Client contract and errors: https://github.com/Nelcota/Nelcota/blob/main/sdk/typescript/docs/contract.md',
    '- Roles and JWT: https://github.com/Nelcota/Nelcota/blob/main/docs/jwt-and-roles.md',
    '- Storage: https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md',
    '- Troubleshooting (empty results, 401/403, row cap): https://github.com/Nelcota/Nelcota/blob/main/docs/troubleshooting.md',
    '',
  ].join('\n')
}
