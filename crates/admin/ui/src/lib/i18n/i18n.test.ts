import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '$lib/transport/api'
import { detectLocale, errorMessage, i18n, t, translate } from './index.svelte'

describe('detectLocale', () => {
  it('prefers a saved choice', () => {
    expect(detectLocale('en', ['pt-BR'])).toBe('en')
    expect(detectLocale('pt-BR', ['en-US'])).toBe('pt-BR')
  })

  it('uses Portuguese for any Portuguese browser and English otherwise', () => {
    expect(detectLocale(null, ['pt-PT', 'en'])).toBe('pt-BR')
    expect(detectLocale(null, ['fr-FR', 'PT-br'])).toBe('pt-BR')
    expect(detectLocale(null, ['es-ES', 'en-GB'])).toBe('en')
    expect(detectLocale(null, [])).toBe('en')
    expect(detectLocale('klingon', ['de'])).toBe('en')
  })
})

describe('t', () => {
  it('follows the current language', () => {
    i18n.locale = 'pt-BR'
    expect(t('common.cancel')).toBe('Cancelar')
    i18n.locale = 'en'
    expect(t('common.cancel')).toBe('Cancel')
  })

  it('fills in parameters and leaves unknown ones visible', () => {
    expect(translate('en', 'common.page', { page: 3 })).toBe('Page 3')
    expect(translate('en', 'common.page')).toBe('Page {page}')
  })

  it('uses the plural for zero in Portuguese too', () => {
    expect(translate('pt-BR', 'overview.summary.users', { count: 0 })).toBe('0 usuários')
    expect(translate('pt-BR', 'overview.summary.users', { count: 1 })).toBe('1 usuário')
    expect(translate('en', 'overview.summary.users', { count: 0 })).toBe('0 users')
  })

  it('returns the key for a missing text (visible in development)', () => {
    expect(translate('en', 'common.nope')).toBe('common.nope')
  })
})

describe('errorMessage', () => {
  it('shows the server text when the code has no translation', () => {
    i18n.locale = 'pt-BR'
    expect(errorMessage(new ApiError('relation "x" does not exist', 400, 'not_a_known_code'))).toBe(
      'relation "x" does not exist',
    )
    expect(errorMessage(new Error('failed'))).toBe('failed')
    expect(errorMessage('text')).toBe('text')
  })
})

// A fresh copy of the module, with no catalog loaded yet (the test setup loads
// both languages into the shared one).
async function freshI18n() {
  vi.resetModules()
  return import('./index.svelte')
}

describe('catalog loading', () => {
  afterEach(() => {
    vi.doUnmock('./messages/en')
    vi.resetModules()
  })

  it('loads only the requested language', async () => {
    const fresh = await freshI18n()
    expect(fresh.translate('en', 'common.cancel')).toBe('common.cancel')
    await fresh.loadLocale('en')
    expect(fresh.translate('en', 'common.cancel')).toBe('Cancel')
    // No fallback to the other language: Portuguese was never downloaded.
    expect(fresh.translate('pt-BR', 'common.cancel')).toBe('common.cancel')
  })

  it('reuses one download per language', async () => {
    const fresh = await freshI18n()
    expect(fresh.loadLocale('en')).toBe(fresh.loadLocale('en'))
  })

  it('keeps the current language until the new one has loaded', async () => {
    const fresh = await freshI18n()
    await fresh.loadLocale('pt-BR')
    fresh.i18n.locale = 'pt-BR'
    const switching = fresh.setLocale('en')
    expect(fresh.i18n.locale).toBe('pt-BR')
    expect(fresh.t('common.cancel')).toBe('Cancelar')
    await switching
    expect(fresh.i18n.locale).toBe('en')
    expect(fresh.t('common.cancel')).toBe('Cancel')
  })

  it('applies the last choice when switches overlap', async () => {
    const fresh = await freshI18n()
    await fresh.loadLocale('pt-BR')
    fresh.i18n.locale = 'pt-BR'
    const toEnglish = fresh.setLocale('en')
    const backToPortuguese = fresh.setLocale('pt-BR')
    await Promise.all([toEnglish, backToPortuguese])
    expect(fresh.i18n.locale).toBe('pt-BR')
  })

  it('keeps the current language when the download fails, and can retry', async () => {
    vi.doMock('./messages/en', () => {
      throw new TypeError('Failed to fetch dynamically imported module')
    })
    const fresh = await freshI18n()
    await fresh.loadLocale('pt-BR')
    fresh.i18n.locale = 'pt-BR'
    await expect(fresh.setLocale('en')).rejects.toThrow()
    expect(fresh.i18n.locale).toBe('pt-BR')
    vi.doUnmock('./messages/en')
    await fresh.setLocale('en')
    expect(fresh.i18n.locale).toBe('en')
  })

  it('resolves quietly when a failed switch was already replaced by another', async () => {
    vi.doMock('./messages/en', () => {
      throw new TypeError('Failed to fetch dynamically imported module')
    })
    const fresh = await freshI18n()
    await fresh.loadLocale('pt-BR')
    fresh.i18n.locale = 'pt-BR'
    const toEnglish = fresh.setLocale('en')
    const backToPortuguese = fresh.setLocale('pt-BR')
    await expect(toEnglish).resolves.toBeUndefined()
    await backToPortuguese
    expect(fresh.i18n.locale).toBe('pt-BR')
  })
})
