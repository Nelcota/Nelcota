import { Marked, Renderer, type Tokens } from 'marked'
import type { CodeLang } from '$lib/components/shared/highlight'
import { guideLink } from './content'
import { translateTokens, type TranslationCatalog } from './prose'

// Branding drafts are kept in the repository but are not guide illustrations.
const assets = import.meta.glob<string>([
  '../../../../../../../docs/assets/*.png',
  '!../../../../../../../docs/assets/nelcota-github-avatar*.png',
], { query: '?url', import: 'default', eager: true })
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
// Anchor IDs have their own character allowlist; they are never parsed as HTML.
export const headingSlug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')

export type Block =
  | { type: 'html'; html: string }
  | { type: 'heading'; id: string; text: string; html: string; level: number }
  | { type: 'code'; code: string; lang?: CodeLang }

const codeLang = (lang = ''): CodeLang | undefined => {
  if (['ts', 'js', 'typescript', 'javascript'].includes(lang)) return 'ts'
  if (['sh', 'shell', 'bash'].includes(lang)) return 'sh'
  return lang === 'sql' || lang === 'env' ? lang : undefined
}

/** Only repository text is parsed; raw HTML and unsafe URLs are never rendered. */
export function readMarkdown(markdown: string, source: string, catalog?: TranslationCatalog): Block[] {
  const ids = new Map<string, number>()
  const marked = new Marked({ renderer: {
    html({ text }) { return escape(text) },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      const target = guideLink(href, source)
      if (!target) return text
      const external = /^https?:/.test(target)
      return `<a href="${escape(target)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`
    },
    image({ href, text }) {
      let path: URL
      try { path = new URL(href, `https://nelcota.local/${source}`) }
      catch { return escape(text) }
      const asset = path.hostname === 'nelcota.local' ? assets[`../../../../../../../${path.pathname.slice(1)}`] : undefined
      return asset ? `<img src="${escape(asset)}" alt="${escape(text)}" loading="lazy" />` : escape(text)
    },
    // Tables can scroll without making the page wider on a phone.
    table(token) {
      return `<div class="guide-table" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>`
    },
  } })
  const tokens = marked.lexer(markdown)
  // Public section URLs always use source-language slugs, even after translation.
  const headingIds = new Map<Tokens.Heading, string>()
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading' || (index === 0 && token.depth === 1)) continue
    const heading = token as Tokens.Heading
    const slug = headingSlug(heading.text)
    const count = ids.get(slug) ?? 0
    ids.set(slug, count + 1)
    headingIds.set(heading, count ? `${slug}-${count}` : slug)
  }
  if (catalog) translateTokens(tokens, catalog)
  return tokens.flatMap((token, index): Block[] => {
    if (token.type === 'space' || token.type === 'def' || (index === 0 && token.type === 'heading' && token.depth === 1)) return []
    if (token.type === 'code') return [{ type: 'code', code: token.text, lang: codeLang(token.lang) }]
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      const html = marked.parseInline(heading.text, { async: false })
      return [{ type: 'heading', id: headingIds.get(heading)!, text: heading.text.replace(/[`*_]/g, ''), html, level: Math.max(2, heading.depth) }]
    }
    return [{ type: 'html', html: marked.parser([token]) }]
  })
}
