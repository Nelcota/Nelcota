import { describe, expect, it } from 'vitest'
import { authSnippets, jsObject, jsString, sampleRow, sampleValue, sdkSetup, tableSnippets, type SnippetColumn } from './api-examples'

const col = (name: string, type: string, extra: Partial<SnippetColumn> = {}): SnippetColumn => ({
  name,
  type,
  has_default: false,
  generated: false,
  nullable: true,
  ...extra,
})

const columns = [
  col('id', 'bigint', { has_default: true, nullable: false }),
  col('title', 'text', { nullable: false }),
  col('done', 'boolean'),
  col('slug', 'text', { generated: true }),
  col('created_at', 'timestamp with time zone', { has_default: true }),
]

describe('sample values and body', () => {
  it('plausible value per type', () => {
    expect(sampleValue('integer')).toBe(1)
    expect(sampleValue('uuid')).toMatch(/^0{8}-/)
    expect(sampleValue('text[]')).toEqual([])
    expect(sampleValue('jsonb')).toEqual({})
  })

  it('body leaves out DEFAULT and generated columns, required ones first', () => {
    expect(sampleRow(columns)).toEqual({ title: 'example', done: true })
  })
})

describe('table examples', () => {
  const snippets = tableSnippets('https://shop.example.com', 'tasks', columns)

  it('covers list, filter, insert, update and delete', () => {
    expect(snippets.map((s) => s.id)).toEqual(['list', 'filter', 'insert', 'update', 'delete'])
  })

  it('correct URL, filter and body', () => {
    const byId = Object.fromEntries(snippets.map((s) => [s.id, s]))
    expect(byId.list.code.curl).toContain("'https://shop.example.com/rest/v1/tasks?select=*&limit=20'")
    expect(byId.filter.code.curl).toContain('title=eq.example')
    expect(byId.filter.params).toEqual({ column: 'title' })
    expect(byId.insert.code.curl).toContain(`-d '{"title":"example","done":true}'`)
    expect(byId.insert.code.js).toContain("Prefer: 'return=representation'")
  })

  it('escapes single quotes for the shell', () => {
    const quoted = tableSnippets('http://x', 't', [col("o'clock", 'text', { nullable: false })])
    expect(quoted.find((s) => s.id === 'insert')!.code.curl).toContain(`'{"o'\\''clock":"example"}'`)
  })

  it('encodes the table name in the URL', () => {
    expect(tableSnippets('http://x', 'order items', [])[0].code.js).toContain('/rest/v1/order%20items')
  })
})

describe('SDK examples', () => {
  const snippets = tableSnippets('https://shop.example.com', 'tasks', columns)
  const byId = Object.fromEntries(snippets.map((s) => [s.id, s.code.ts]))

  it('use the typed client with the table and its columns', () => {
    expect(byId.list).toBe("const { data, error } = await nelcota.from('tasks')\n  .select('*')\n  .limit(20)")
    expect(byId.filter).toContain(".eq('title', 'example')")
    expect(byId.insert).toContain(".insert({\n    title: 'example',\n    done: true,\n  })\n  .select()\n  .single()")
    expect(byId.update).toContain(".eq('id', 1)")
    expect(byId.delete).toBe("const { error } = await nelcota.from('tasks').delete().eq('id', 1)")
  })

  it('quote names and values as JavaScript strings', () => {
    expect(jsString("o'clock\\x")).toBe("'o\\'clock\\\\x'")
    expect(jsObject({ 'two words': 1, plain: 'a' })).toBe("{\n  'two words': 1,\n  plain: 'a',\n}")
    const quoted = tableSnippets('http://x', "it's", [col('id', 'integer', { nullable: false })])
    expect(quoted[0].code.ts).toContain("nelcota.from('it\\'s')")
  })

  it('setup points the client at the project', () => {
    const setup = sdkSetup('https://shop.example.com')
    expect(setup.install).toBe('bun add @nelcota/client   # or: npm install @nelcota/client')
    expect(setup.client).toContain("createClient<Database>('https://shop.example.com')")
  })

  it('auth uses sessions instead of raw tokens', () => {
    const [signup, login, refresh] = authSnippets('https://shop.example.com')
    expect(signup.code.ts).toContain('nelcota.auth.signUp({ email, password })')
    expect(login.code.ts).toContain('signInWithPassword')
    expect(refresh.code.ts).toContain('nelcota.auth.onChange')
  })
})

describe('authentication examples', () => {
  it('signup, password login and refresh', () => {
    const snippets = authSnippets('https://shop.example.com')
    expect(snippets.map((s) => s.id)).toEqual(['signup', 'login', 'refresh'])
    expect(snippets[1].code.curl).toContain('/auth/v1/token?grant_type=password')
  })
})
