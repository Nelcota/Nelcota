// Command palette search. The default fuzzy search accepts scattered letters
// in order ("orders" matched "page Our Data Records"); here every typed term
// must appear whole, ignoring accents and case.

/** Lowercase text without accents. Callers searching large texts cache the result. */
export const normalizeSearchText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Score in the format of bits-ui's `filter`: 0 hides the item; higher comes
 * first. Terms at the start of a word score higher than in the middle.
 */
export function commandScore(value: string, search: string, keywords: string[] = []): number {
  return normalizedScore(normalizeSearchText([value, ...keywords].join(' ')), search)
}

/** {@link commandScore} for a haystack that already went through {@link normalizeSearchText}. */
export function normalizedScore(haystack: string, search: string): number {
  const terms = normalizeSearchText(search).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 1
  if (terms.every((term) => haystack.includes(term)) === false) return 0
  const atWordStart = terms.every((term) => new RegExp(`(^|[\\s_./-])${escapeRegExp(term)}`).test(haystack))
  return atWordStart ? 1 : 0.5
}
