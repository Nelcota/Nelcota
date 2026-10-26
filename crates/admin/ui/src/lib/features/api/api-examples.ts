// API usage examples (curl, plain fetch and the TypeScript SDK) generated from the table.
// Pure functions: they take the base URL and the columns and return code.
// Labels and descriptions live in the i18n catalog (`connect.snippets.<id>`).

export type Lang = 'curl' | 'js' | 'ts'

export type SnippetId = 'list' | 'filter' | 'insert' | 'update' | 'delete' | 'signup' | 'login' | 'refresh'

export interface Snippet {
  id: SnippetId
  /** Values for the description (e.g. the column used in the filter example). */
  params?: Record<string, string>
  code: Record<Lang, string>
}

export interface SnippetColumn {
  name: string
  type: string
  has_default: boolean
  generated: boolean
  nullable: boolean
}

/** Plausible sample value for the column type. */
export function sampleValue(type: string): unknown {
  const t = type.toLowerCase()
  if (t.endsWith('[]')) return []
  if (['smallint', 'integer', 'bigint', 'int2', 'int4', 'int8'].includes(t)) return 1
  if (['numeric', 'real', 'double precision', 'float4', 'float8'].includes(t)) return 9.9
  if (t === 'boolean' || t === 'bool') return true
  if (t === 'uuid') return '00000000-0000-0000-0000-000000000000'
  if (t.startsWith('timestamp')) return '2026-01-01T12:00:00Z'
  if (t === 'date') return '2026-01-01'
  if (t === 'json' || t === 'jsonb') return {}
  return 'example'
}

/** Insert body: columns without DEFAULT that are not generated (required ones first). */
export function sampleRow(columns: readonly SnippetColumn[]): Record<string, unknown> {
  const fillable = columns.filter((c) => !c.has_default && !c.generated)
  const ordered = [...fillable.filter((c) => !c.nullable), ...fillable.filter((c) => c.nullable)]
  return Object.fromEntries(ordered.slice(0, 4).map((c) => [c.name, sampleValue(c.type)]))
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** A single-quoted JavaScript string literal. */
export const jsString = (text: string) =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`

/** An object literal, with unquoted keys where JavaScript allows them. */
export function jsObject(row: Record<string, unknown>, indent = ''): string {
  const entries = Object.entries(row)
  if (entries.length === 0) return '{}'
  const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name))
  const value = (v: unknown) => (typeof v === 'string' ? jsString(v) : JSON.stringify(v))
  return `{\n${entries.map(([k, v]) => `${indent}  ${key(k)}: ${value(v)},`).join('\n')}\n${indent}}`
}

/** How a project creates its client (as in the SDK's README). */
export function sdkSetup(base: string): { install: string; client: string } {
  return {
    install: 'npm install @nelcota/client   # or: bun add @nelcota/client',
    client: `import { createClient } from '@nelcota/client'\nimport type { Database } from './database'\n\nexport const nelcota = createClient<Database>(${jsString(base)})`,
  }
}

/** First column that makes a good filter example (text, not the numeric PK). */
function filterColumn(columns: readonly SnippetColumn[]): SnippetColumn | undefined {
  return columns.find((c) => c.type === 'text' || c.type.startsWith('character varying')) ?? columns[0]
}

export function tableSnippets(base: string, table: string, columns: readonly SnippetColumn[]): Snippet[] {
  const url = `${base}/rest/v1/${encodeURIComponent(table)}`
  const row = sampleRow(columns)
  const body = JSON.stringify(row)
  const bodyPretty = JSON.stringify(row, null, 2).replaceAll('\n', '\n  ')
  const filter = filterColumn(columns)
  const filterQuery = filter ? `${encodeURIComponent(filter.name)}=eq.${encodeURIComponent(String(sampleValue(filter.type)))}` : ''
  const auth = '-H "Authorization: Bearer $TOKEN"'
  const authJs = "headers: { Authorization: `Bearer ${token}` }"
  // The SDK sends the signed-in user's token by itself.
  const from = `nelcota.from(${jsString(table)})`
  const filterValue = filter ? sampleValue(filter.type) : undefined
  const sdkValue = typeof filterValue === 'string' ? jsString(filterValue) : JSON.stringify(filterValue)

  return [
    {
      id: 'list',
      code: {
        curl: `curl ${shellQuote(`${url}?select=*&limit=20`)} \\\n  ${auth}`,
        js: `const res = await fetch('${url}?select=*&limit=20', {\n  ${authJs},\n})\nconst rows = await res.json()`,
        ts: `const { data, error } = await ${from}\n  .select('*')\n  .limit(20)`,
      },
    },
    ...(filter
      ? [
          {
            id: 'filter' as const,
            params: { column: filter.name },
            code: {
              curl: `curl ${shellQuote(`${url}?${filterQuery}`)} \\\n  ${auth}`,
              js: `const res = await fetch('${url}?${filterQuery}', {\n  ${authJs},\n})`,
              ts: `const { data, error } = await ${from}\n  .select('*')\n  .eq(${jsString(filter.name)}, ${sdkValue})`,
            },
          },
        ]
      : []),
    {
      id: 'insert',
      code: {
        curl: `curl -X POST ${shellQuote(url)} \\\n  ${auth} \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: return=representation" \\\n  -d ${shellQuote(body)}`,
        js: `const res = await fetch('${url}', {\n  method: 'POST',\n  headers: {\n    Authorization: \`Bearer \${token}\`,\n    'Content-Type': 'application/json',\n    Prefer: 'return=representation',\n  },\n  body: JSON.stringify(${bodyPretty}),\n})`,
        ts: `const { data, error } = await ${from}\n  .insert(${jsObject(row, '  ')})\n  .select()\n  .single()`,
      },
    },
    {
      id: 'update',
      code: {
        curl: `curl -X PATCH ${shellQuote(`${url}?id=eq.1`)} \\\n  ${auth} \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(body)}`,
        js: `await fetch('${url}?id=eq.1', {\n  method: 'PATCH',\n  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },\n  body: JSON.stringify(${bodyPretty}),\n})`,
        ts: `const { error } = await ${from}\n  .update(${jsObject(row, '  ')})\n  .eq('id', 1)`,
      },
    },
    {
      id: 'delete',
      code: {
        curl: `curl -X DELETE ${shellQuote(`${url}?id=eq.1`)} \\\n  ${auth}`,
        js: `await fetch('${url}?id=eq.1', {\n  method: 'DELETE',\n  ${authJs},\n})`,
        ts: `const { error } = await ${from}.delete().eq('id', 1)`,
      },
    },
  ]
}

export function authSnippets(base: string): Snippet[] {
  const auth = `${base}/auth/v1`
  const credentials = JSON.stringify({ email: 'ana@example.com', password: 'a-strong-password' })
  return [
    {
      id: 'signup',
      code: {
        curl: `curl -X POST ${shellQuote(`${auth}/signup`)} \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(credentials)}`,
        js: `const res = await fetch('${auth}/signup', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ email, password }),\n})\nconst { access_token, refresh_token } = await res.json()`,
        ts: `const { data, error } = await nelcota.auth.signUp({ email, password })`,
      },
    },
    {
      id: 'login',
      code: {
        curl: `curl -X POST ${shellQuote(`${auth}/token?grant_type=password`)} \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(credentials)}`,
        js: `const res = await fetch('${auth}/token?grant_type=password', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ email, password }),\n})\nconst { access_token, refresh_token } = await res.json()`,
        ts: `const { data: session, error } = await nelcota.auth.signInWithPassword({ email, password })`,
      },
    },
    {
      id: 'refresh',
      code: {
        curl: `curl -X POST ${shellQuote(`${auth}/token?grant_type=refresh_token`)} \\\n  -H "Content-Type: application/json" \\\n  -d '{"refresh_token": "..."}'`,
        js: `const res = await fetch('${auth}/token?grant_type=refresh_token', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ refresh_token }),\n})`,
        ts: `nelcota.auth.onChange((event, session) => {\n  if (event === 'signed_out') showLogin()\n})`,
      },
    },
  ]
}
