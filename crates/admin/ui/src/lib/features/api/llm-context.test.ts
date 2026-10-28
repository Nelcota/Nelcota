import { describe, expect, it } from 'vitest'
import { latestMigration, llmContext, type LlmContextInput } from './llm-context'

const rls = (enabled: boolean) => ({ state: enabled ? 'ok' as const : 'danger' as const, label: enabled ? 'enabled' : 'disabled', enabled, forced: false, policies: enabled ? 1 : 0 })
const input = (overrides: Partial<LlmContextInput> = {}): LlmContextInput => ({
  origin: 'https://api.acme.test',
  project: 'acme',
  migrationVersion: 4,
  generatedAt: new Date('2026-10-26T12:00:00Z'),
  types: 'export type Database = {\n  public: { Tables: { notes: { Row: { id: number; body: string } } } }\n}\n',
  policies: {
    schema: 'public',
    exposed_without_rls: ['logs'],
    anon_functions: ['cart_total'],
    tables: [
      { name: 'notes', rls: rls(true), exposed_without_rls: false, policies: [{ name: 'own notes', permissive: true, roles: ['authenticated'], command: 'SELECT', using: '(owner = auth.uid())', check: null }] },
      { name: 'logs', rls: rls(false), exposed_without_rls: true, policies: [] },
    ],
  },
  storage: { enabled: true, backend: 'disk', max_file_size: 52428800, max_total_size: null, public_url: null, buckets: [
    { id: 'avatars', public: true, file_size_limit: 2097152, allowed_mime_types: ['image/*'], created_at: '', files: 3, bytes: 10 },
  ] } as LlmContextInput['storage'],
  ...overrides,
})

describe('LLM context', () => {
  it('names the project, its API address and the real schema', () => {
    const text = llmContext(input())
    expect(text).toMatch(/^# acme: Nelcota backend/)
    expect(text).toContain("createClient<Database>('https://api.acme.test')")
    expect(text).toContain('`https://api.acme.test/rest/v1/`')
    expect(text).toContain('notes: { Row: { id: number; body: string } }')
    expect(text).toContain('2026-10-26T12:00:00.000Z')
    // Examples use a table and a bucket that exist, not invented ones.
    expect(text).toContain("nelcota.from('notes')")
    expect(text).toContain("nelcota.storage.from('avatars')")
  })

  it('describes access rules and warns about tables without RLS', () => {
    const text = llmContext(input())
    expect(text).toContain('- `own notes`: SELECT for authenticated; using `(owner = auth.uid())`')
    expect(text).toContain('RLS is off on `logs`')
    expect(text).toContain('Functions anonymous visitors can call: `cart_total`.')
    expect(text).toContain('- `avatars`: public (anyone can download with publicUrl); files up to 2 MiB; types image/*')
  })

  it('never carries a secret and survives backticks in the schema', () => {
    const text = llmContext(input({ types: 'type T = `a ``` b`\n' }))
    expect(text).toContain('````ts\ntype T = `a ``` b`\n````')
    expect(text).not.toMatch(/eyJ[\w-]+\./) // no JWT
    expect(text).toContain('Never put a `service_role` token in a browser')
  })

  it('says when storage is disabled and falls back to placeholders', () => {
    const text = llmContext(input({ storage: { enabled: false }, policies: { schema: 'public', exposed_without_rls: [], anon_functions: [], tables: [] } }))
    expect(text).toContain('No tables are exposed yet. Apply your application migrations')
    expect(text).toContain('Storage is disabled on this server.')
    expect(text).toContain("nelcota.from('your_table')")
    expect(text).not.toContain('RLS is off')
  })
})

it('records the applied version rather than pending/generated versions', () => {
  expect(llmContext(input())).toContain('Latest applied migration: V4')
  expect(llmContext(input({ migrationVersion: null }))).toContain('Latest applied migration: none')
  const migration = (version: number, applied_on: string | null) => ({ version, applied_on, name: 'test', in_folder: true, from_panel: false })
  expect(latestMigration({ migrations: [migration(9, null), migration(4, 'date'), migration(2, 'date')], pending: [], next_version: 10, folder: null })).toBe(4)
  expect(latestMigration({ migrations: [], pending: [], next_version: 1, folder: null })).toBeNull()
})
