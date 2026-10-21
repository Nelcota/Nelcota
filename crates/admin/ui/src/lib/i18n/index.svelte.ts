// Panel translations (pt-BR and English). Everything outside the panel
// interface (code, server messages, docs) is English; the panel picks the
// browser language on first visit and remembers a manual choice.
//
// Each area of the panel owns a module in ./messages exporting
// `{ 'pt-BR': {...}, en: {...} }`. The English object is typed against the
// Portuguese one, so a missing or extra key is a type error.

import { ApiError } from '$lib/transport/api-error'
import { readText, write } from '$lib/browser/local-storage'
import common from './messages/common'
import shell from './messages/shell'
import login from './messages/login'
import overview from './messages/overview'
import users from './messages/users'
import storage from './messages/storage'
import projects from './messages/projects'
import profile from './messages/profile'
import policies from './messages/policies'
import connect from './messages/connect'
import signIn from './messages/signIn'
import migrations from './messages/migrations'
import tables from './messages/tables'
import sql from './messages/sql'
import palette from './messages/palette'
import errors from './messages/errors'
import guided from './messages/guided'
import guides from './messages/guides'
import webhooks from './messages/webhooks'
import updates from './messages/updates'
import host from './messages/host'
import server from './messages/server'

export type Locale = 'pt-BR' | 'en'
export const LOCALES: Locale[] = ['pt-BR', 'en']

const catalogs = {
  common,
  shell,
  login,
  overview,
  users,
  storage,
  projects,
  profile,
  policies,
  connect,
  signIn,
  migrations,
  tables,
  sql,
  palette,
  errors,
  guided,
  guides,
  webhooks,
  updates,
  host,
  server,
}

/** `{ one, other }` entries pick a form from `params.count`. */
export type Plural = { one: string; other: string }

/** Same shape as the Portuguese catalog, with every text as `string`. */
export type Messages<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Messages<T[K]>
}

type Catalog = { [K in keyof typeof catalogs]: (typeof catalogs)[K]['pt-BR'] }

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string | Plural ? `${P}${K}` : Paths<T[K], `${P}${K}.`>
}[keyof T & string]

export type MessageKey = Paths<Catalog>
export type Params = Record<string, string | number>

const KEY = 'nelcota.locale'

/** Saved choice, else the browser language (Portuguese → pt-BR, anything else → en). */
export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'pt-BR' || saved === 'en') return saved
  return languages.some((l) => l.toLowerCase().startsWith('pt')) ? 'pt-BR' : 'en'
}

const browserLanguages = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])

export const i18n = $state<{ locale: Locale }>({
  locale: detectLocale(readText(KEY, '') || null, browserLanguages),
})

if (typeof document !== 'undefined') document.documentElement.lang = i18n.locale

export function setLocale(locale: Locale) {
  i18n.locale = locale
  write(KEY, locale)
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

function lookup(locale: Locale, key: string): string | Plural | undefined {
  let node: unknown = catalogs
  const [area, ...rest] = key.split('.')
  node = (node as Record<string, Record<Locale, unknown>>)[area]?.[locale]
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

export function translate(locale: Locale, key: string, params?: Params): string {
  const entry = lookup(locale, key) ?? lookup('pt-BR', key)
  if (entry === undefined) return key
  if (typeof entry === 'string') return interpolate(entry, params)
  const count = Number(params?.count ?? 0)
  // CLDR files 0 under `one` in Portuguese, but people write "0 usuários".
  const form = count !== 0 && new Intl.PluralRules(locale).select(count) === 'one' ? 'one' : 'other'
  return interpolate(entry[form], params)
}

/** Does the current language have this key? (Server error codes may be new.) */
export function hasMessage(key: string): boolean {
  return lookup(i18n.locale, key) !== undefined
}

/**
 * Message for a failed request: the translation of the server's error code
 * when there is one, else the server's (English) text, e.g. a Postgres error.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code && hasMessage(`errors.${error.code}`)) {
    return translate(i18n.locale, `errors.${error.code}`, error.params)
  }
  if (isNetworkError(error)) return translate(i18n.locale, 'errors.network')
  return error instanceof Error ? error.message : String(error)
}

/** A request that never reached the server (fetch rejects with a TypeError). */
export const isNetworkError = (error: unknown) => error instanceof TypeError

/** Locale for `Intl` formatters (dates, numbers). */
export const intlLocale = () => i18n.locale
