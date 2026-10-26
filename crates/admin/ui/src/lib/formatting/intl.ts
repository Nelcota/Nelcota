// Intl formatters are slow to build and some are used per grid cell or per
// translated plural: reuse one per locale and options.

/** Locales × option sets in use stay far below this; the cap only bounds odd inputs. */
const MAX_CACHED_FORMATTERS = 64

const formatters = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.PluralRules>()

function cacheKey(kind: string, locale: string, options: object): string {
  // `undefined` options are dropped by JSON, as Intl ignores them too.
  return `${kind}\u0000${locale}\u0000${JSON.stringify(options)}`
}

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.PluralRules>(key: string, create: () => T): T {
  const existing = formatters.get(key)
  if (existing !== undefined) return existing as T
  const formatter = create()
  if (formatters.size >= MAX_CACHED_FORMATTERS) {
    const oldest = formatters.keys().next()
    if (oldest.done === false) formatters.delete(oldest.value)
  }
  formatters.set(key, formatter)
  return formatter
}

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  return cached(cacheKey('date', locale, options), () => new Intl.DateTimeFormat(locale, options))
}

export function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(cacheKey('number', locale, options), () => new Intl.NumberFormat(locale, options))
}

export function pluralRules(locale: string, options: Intl.PluralRulesOptions = {}): Intl.PluralRules {
  return cached(cacheKey('plural', locale, options), () => new Intl.PluralRules(locale, options))
}
