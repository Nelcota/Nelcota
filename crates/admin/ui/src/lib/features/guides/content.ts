// These sources ship with the panel. Documentation changes are reflected on
// the next build, with no network request. Only prose has a translation catalog.
const sources = import.meta.glob<string>([
  '../../../../../../../docs/*.md',
  '../../../../../../../sdk/typescript/README.md',
  '../../../../../../../sdk/typescript/CHANGELOG.md',
  '../../../../../../../sdk/typescript/docs/*.md',
  '../../../../../../../sdk/rust/README.md',
  '../../../../../../../sdk/rust/docs/*.md',
  '../../../../../../../examples/notes.sql',
  '../../../../../../../sdk/typescript/examples/server.mjs',
], { query: '?raw', import: 'default', eager: true })

import { guides, guidePath, type Guide } from './registry'
import { proseFragments, type TranslationCatalog } from './prose'
import type { Locale } from '$lib/i18n/index.svelte'
export { guides, guideGroups, guidePath, type Guide, type GuideId } from './registry'

const translations = import.meta.glob<TranslationCatalog>('../../../../../../../docs/i18n/pt-BR/*.json', { import: 'default', eager: true })

export function guideSource(guide: Guide): string {
  return sources[`../../../../../../../${guide.source}`] ?? ''
}

export function guideTranslation(guide: Guide, locale: Locale): TranslationCatalog | undefined {
  if (locale !== 'pt-BR' || 'language' in guide || 'code' in guide || guide.id === 'openapi') return undefined
  const catalog = translations[`../../../../../../../docs/i18n/pt-BR/${guide.id}.json`]
  if (!catalog) throw new Error(`Missing Portuguese guide: ${guide.source}`)
  return catalog
}

const searchText = new Map<string, string>()
export function guideSearchText(guide: Guide, locale: Locale): string {
  const key = `${locale}:${guide.id}`
  if (!searchText.has(key)) {
    const source = guideSource(guide)
    const catalog = guideTranslation(guide, locale)
    searchText.set(key, `${source}\n${catalog ? proseFragments(source).map(fragment => catalog[fragment]).join('\n') : ''}`)
  }
  return searchText.get(key)!
}

/** Resolve repository documentation links into the reader, including GitHub URLs. */
export function guideLink(link: string, source: string): string | null {
  if (link.startsWith('#')) {
    const guide = guides.find(guide => guide.source === source)
    return guide ? `/admin${guidePath(guide.id, link.slice(1))}` : null
  }
  let url: URL
  try { url = new URL(link, `https://nelcota.local/${source}`) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  let path: string
  try { path = decodeURIComponent(url.pathname).replace(/^\//, '') } catch { return null }
  if (url.hostname !== 'github.com' && url.hostname !== 'nelcota.local') return url.href
  if (url.hostname === 'github.com') {
    // Keep links from documentation published before the organization transfer.
    const prefix = ['Nelcota/Nelcota/', 'HanielCota/Nelcota/'].find(prefix => path.startsWith(prefix))
    if (!prefix) return null
    path = path.slice(prefix.length).replace(/^(?:blob|tree)\/[^/]+\//, '')
    if (!path) return '/admin/guides'
  }
  const guide = guides.find(guide => guide.source === path)
  if (guide) return `/admin${guidePath(guide.id, url.hash.slice(1))}`
  // Longer operational references live outside the embedded reader.
  if (['docs/onboarding/notes.md', 'docs/operational-alerts.md'].includes(path)) return `https://github.com/Nelcota/Nelcota/blob/main/${path}${url.hash}`
  // Runnable examples have a complete schema and server recipe in the reader.
  if (path === 'sdk/typescript/examples/') return '/admin/guides/example'
  if (path === 'scripts/install.sh') return '/admin/guides/quickstart'
  return null
}
