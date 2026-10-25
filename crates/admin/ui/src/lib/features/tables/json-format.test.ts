import { describe, expect, it } from 'vitest'
import { formatJson } from './json-format'

describe('JSON formatting', () => {
  it('formats long escaped strings without exhausting the regular-expression stack', () => {
    const raw = `{"message":"${'\\n'.repeat(100_000)}"}`
    expect(formatJson(raw)).toBe(`{\n  "message": "${'\\n'.repeat(100_000)}"\n}`)
  })

  it('bounds indentation expansion for deeply nested input while retaining its tokens', () => {
    const raw = '['.repeat(512) + '9007199254740993' + ']'.repeat(512)
    const formatted = formatJson(raw)
    expect(formatted.replaceAll(/\s/g, '')).toBe(raw)
    expect(formatted.length).toBeLessThan(raw.length * 80)
  })

  it('preserves integer and decimal lexemes, exponents and escaped strings', () => {
    expect(formatJson('{"id":9007199254740993,"n":0.12345678901234567890,"e":1e400,"s":"a\\\"b\\u0063"}'))
      .toBe('{\n  "id": 9007199254740993,\n  "n": 0.12345678901234567890,\n  "e": 1e400,\n  "s": "a\\\"b\\u0063"\n}')
  })
  it('formats nested and empty containers without changing duplicate keys', () => {
    expect(formatJson('{"a":[{},[],true,null,{"x":1,"x":2}]}')).toBe(
      '{\n  "a": [\n    {},\n    [],\n    true,\n    null,\n    {\n      "x": 1,\n      "x": 2\n    }\n  ]\n}',
    )
  })
  it('rejects invalid JSON and accepts scalar JSON', () => {
    expect(() => formatJson('{a:1}')).toThrow()
    expect(formatJson(' 9007199254740993 ')).toBe('9007199254740993')
  })
})
