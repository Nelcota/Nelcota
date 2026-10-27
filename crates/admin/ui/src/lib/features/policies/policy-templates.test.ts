import { describe, expect, it } from 'vitest'
import { POLICY_TEMPLATES, guessOwnerColumn, quoteIfNeeded, templateText } from './policy-templates'
import { policyFields, type ColumnInfo } from '$lib/shared/schema/ddl'
import { i18n } from '$lib/i18n/index.svelte'

const column = (name: string, data_type: string, primary_key = false): ColumnInfo => ({
  name,
  data_type,
  primary_key,
  nullable: true,
  default: null,
  identity: null,
  generated: false,
  unique: null,
  references: null,
  comment: null,
})

describe('policy templates', () => {
  it('each template only uses the expressions its command accepts', () => {
    for (const template of POLICY_TEMPLATES) {
      const policy = template.build('owner')
      const fields = policyFields(policy.command)
      expect(policy.using !== null, `${template.id}: USING`).toBe(fields.using)
      if (!fields.check) expect(policy.check, `${template.id}: WITH CHECK`).toBeNull()
    }
  })

  it('owner templates compare the column with auth.uid()', () => {
    const insert = POLICY_TEMPLATES.find((t) => t.id === 'ownerInsert')!.build('author_id')
    expect(insert.check).toBe('author_id = auth.uid()')
  })

  it('every template has text in both languages', () => {
    for (const locale of ['pt-BR', 'en'] as const) {
      i18n.locale = locale
      for (const template of POLICY_TEMPLATES) {
        const text = templateText(template.id)
        expect(text.label).not.toContain('policies.templates')
        expect(text.name).not.toBe('')
      }
    }
    i18n.locale = 'en'
    expect(templateText('publicRead').name).toBe('public read')
  })

  it('quotes only when needed', () => {
    expect(quoteIfNeeded('user_id')).toBe('user_id')
    expect(quoteIfNeeded('Owner')).toBe('"Owner"')
    expect(quoteIfNeeded('owner id')).toBe('"owner id"')
    // Reserved keywords are quoted: a bare `user` would mean current_user.
    expect(quoteIfNeeded('user')).toBe('"user"')
    expect(quoteIfNeeded('order')).toBe('"order"')
    expect(quoteIfNeeded('users')).toBe('users')
  })
})

describe('owner column', () => {
  it('prefers a uuid with a known name', () => {
    expect(guessOwnerColumn([column('id', 'uuid', true), column('ref', 'uuid'), column('owner', 'uuid')])).toBe('owner')
  })

  it('else the first uuid that is not the PK; else user_id', () => {
    expect(guessOwnerColumn([column('id', 'uuid', true), column('author', 'uuid')])).toBe('author')
    expect(guessOwnerColumn([column('id', 'bigint', true)])).toBe('user_id')
  })
})
