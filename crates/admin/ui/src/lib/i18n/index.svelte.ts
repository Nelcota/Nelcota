// Panel translations (pt-BR and English). Everything outside the panel
// interface (code, server messages, docs) is English; the panel picks the
// browser language on first visit and remembers a manual choice.
//
// Each area of the panel owns a module per language, in ./messages/pt-BR and
// ./messages/en. The English object is typed against the Portuguese one, so a
// missing or extra key is a type error. Each language is a separate chunk:
// main.ts loads the active one before mounting the panel, and a switch loads
// the other one before the interface changes language.

import { ApiError } from '$lib/transport/api-error'
import { numberFormat, pluralRules } from '$lib/formatting/intl'
import { readText, write } from '$lib/browser/local-storage'
import type ptBR from './messages/pt-BR'

export type Locale = 'pt-BR' | 'en'
export const LOCALES: Locale[] = ['pt-BR', 'en']

/** `{ one, other }` entries pick a form from `params.count`. */
export type Plural = { one: string; other: string }

/** Same shape as the Portuguese catalog, with every text as `string`. */
export type Messages<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Messages<T[K]>
}

type Catalog = typeof ptBR

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string | Plural ? `${P}${K}` : Paths<T[K], `${P}${K}.`>
}[keyof T & string]

export type MessageKey = Paths<Catalog>
export type Params = Record<string, string | number>

const KEY = 'nelcota.locale'

const catalogLoaders: Record<Locale, () => Promise<{ default: Messages<Catalog> }>> = {
  'pt-BR': () => import('./messages/pt-BR'),
  en: () => import('./messages/en'),
}
const loadedCatalogs: Partial<Record<Locale, Messages<Catalog>>> = {}
const pendingCatalogs = new Map<Locale, Promise<void>>()

/** Downloads a language's texts once; later calls reuse the same request. */
export function loadLocale(locale: Locale): Promise<void> {
  const pending = pendingCatalogs.get(locale)
  if (pending !== undefined) return pending
  const loading = catalogLoaders[locale]().then((module) => {
    loadedCatalogs[locale] = module.default
  })
  pendingCatalogs.set(locale, loading)
  // A failed download (network, new release) can be tried again later.
  loading.catch(() => pendingCatalogs.delete(locale))
  return loading
}

/** Saved choice, else the browser language (Portuguese → pt-BR, anything else → en). */
export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'pt-BR' || saved === 'en') return saved
  return languages.some((l) => l.toLowerCase().startsWith('pt')) ? 'pt-BR' : 'en'
}

// Fora do navegador (Bun, por exemplo) `navigator` pode existir sem idioma nenhum.
const browserLanguages: readonly string[] =
  typeof navigator === 'undefined'
    ? []
    : (navigator.languages ?? [navigator.language]).filter((language) => typeof language === 'string')

export const i18n = $state<{ locale: Locale }>({
  locale: detectLocale(readText(KEY, '') || null, browserLanguages),
})

if (typeof document !== 'undefined') document.documentElement.lang = i18n.locale

let requestedLocale: Locale = i18n.locale

/**
 * Switches the panel language once its texts have arrived; until then the
 * current language stays on screen. Rejects when the download fails, unless
 * a later switch replaced this one (its outcome is what the user sees).
 */
export async function setLocale(locale: Locale): Promise<void> {
  requestedLocale = locale
  try {
    await loadLocale(locale)
  } catch (error) {
    if (requestedLocale !== locale) return
    throw error
  }
  // A later choice made while this one was downloading wins.
  if (requestedLocale !== locale) return
  i18n.locale = locale
  write(KEY, locale)
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

function lookup(locale: Locale, key: string): string | Plural | undefined {
  const [area, ...rest] = key.split('.')
  let node: unknown = (loadedCatalogs[locale] as Record<string, unknown> | undefined)?.[area]
  for (const part of rest) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && 'one' in node && 'other' in node) return node as Plural
  return undefined
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** Text for `key` in the current language. Reading `i18n.locale` makes templates re-render on a switch. */
export function t(key: MessageKey, params?: Params): string {
  return translate(i18n.locale, key, params)
}

// No fallback to another language: the types make every key exist in both,
// and a fallback would force English users to download the Portuguese texts.
export function translate(locale: Locale, key: string, params?: Params): string {
  const entry = lookup(locale, key)
  if (entry === undefined) return key
  if (typeof entry === 'string') return interpolate(entry, params)
  const count = Number(params?.count ?? 0)
  // CLDR files 0 under `one` in Portuguese, but people write "0 usuários".
  const form = count !== 0 && pluralRules(locale).select(count) === 'one' ? 'one' : 'other'
  // The counted number reads in the language's format ("1.234 usuários").
  const shown = typeof params?.count === 'number' ? { ...params, count: numberFormat(locale).format(params.count) } : params
  return interpolate(entry[form], shown)
}

/** Does the current language have this key? (Server error codes may be new.) */
export function hasMessage(key: string): boolean {
  return lookup(i18n.locale, key) !== undefined
}

/**
 * Message for a failed request: the translation of the server's error code
 * when there is one, else the server's (English) text, e.g. a Postgres error.
 */
export function errorMessage(error: unknown, fallbackKey?: string): string {
  if (error instanceof ApiError && error.code && hasMessage(`errors.${error.code}`)) {
    return translate(i18n.locale, `errors.${error.code}`, error.params)
  }
  if (isNetworkError(error)) return translate(i18n.locale, 'errors.network')
  // Library errors (e.g. Uppy) carry English text; the key gives a translated one.
  if (fallbackKey !== undefined && error instanceof ApiError === false) return translate(i18n.locale, fallbackKey)
  return error instanceof Error ? error.message : String(error)
}

/** A request that never reached the server (fetch rejects with a TypeError). */
export const isNetworkError = (error: unknown) => error instanceof TypeError

/** Locale for `Intl` formatters (dates, numbers). */
export const intlLocale = () => i18n.locale
