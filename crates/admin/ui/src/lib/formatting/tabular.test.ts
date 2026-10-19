import { describe, expect, it } from 'vitest'
import { toCsv, toJson } from './tabular'

describe('CSV', () => {
  it('has a BOM, CRLF and quotes only when needed', () => {
    const csv = toCsv(['id', 'name'], [
      ['1', 'Ana'],
      ['2', 'Ruler, 30cm'],
      ['3', 'says "hi"'],
    ])
    expect(csv).toBe('﻿id,name\r\n1,Ana\r\n2,"Ruler, 30cm"\r\n3,"says ""hi"""\r\n')
  })

  it('NULL becomes an empty field; empty text stays empty too', () => {
    expect(toCsv(['a', 'b'], [[null, '']])).toBe('﻿a,b\r\n,\r\n')
  })

  it('keeps line breaks inside the field', () => {
    expect(toCsv(['t'], [['line 1\nline 2']])).toContain('"line 1\nline 2"')
  })

  it.each([
    '=1+1', '+1+1', '-1+1', '@SUM(1,1)', ' =1+1', '\t=1+1', '\r=1+1', '\n=1+1',
    '\uFEFF=1+1', '\0=1+1', '＝1+1', '＋1+1', '－1+1', '＠SUM(1,1)',
    '=HYPERLINK("https://example.com","open")',
  ])('neutralizes a spreadsheet formula %j', (value) => {
    const escaped = `"\t${value.replaceAll('"', '""')}"`
    expect(toCsv([value], [[value]])).toBe(`\uFEFF${escaped}\r\n${escaped}\r\n`)
  })

  it('preserves negative numeric literals without rounding', () => {
    const values = ['-1', '-0.50', '-1e-3', '-123456789012345678901234567890.123456789']
    expect(toCsv(['n'], values.map((v) => [v]))).toBe(`\uFEFFn\r\n${values.join('\r\n')}\r\n`)
  })
})

describe('JSON', () => {
  it('builds objects per column, keeping the Postgres text', () => {
    const parsed = JSON.parse(toJson(['id', 'price'], [['1', '2.50'], ['2', null]]))
    expect(parsed).toEqual([
      { id: '1', price: '2.50' },
      { id: '2', price: null },
    ])
  })

  it('preserves formula text for lossless data export', () => {
    expect(JSON.parse(toJson(['=header'], [['=1+1']]))).toEqual([{ '=header': '=1+1' }])
  })
})
