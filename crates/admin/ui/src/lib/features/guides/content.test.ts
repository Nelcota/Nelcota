import { describe, expect, it } from 'vitest'
import { bundledSources, guides, guideLink, loadGuideSearchText, loadGuideSource, loadGuideTranslation } from './content'
import { headingSlug, readMarkdown } from './markdown'

describe('bundled guides', () => {
  it('includes every reference without fetching remote documentation', async () => {
    for (const guide of guides.filter(guide => guide.id !== 'openapi')) {
      const source = await loadGuideSource(guide)
      expect(source, guide.source).not.toBe('')
      if (!('code' in guide)) expect(readMarkdown(source, guide.source).length, guide.source).toBeGreaterThan(0)
    }
  })

  it('bundles exactly the registered guide sources', () => {
    const registered = guides.filter(guide => guide.id !== 'openapi').map(guide => guide.source)
    expect([...bundledSources].sort()).toEqual([...registered].sort())
  })

  it('folds only leading paragraphs that still describe a release', async () => {
    for (const guide of guides.filter(guide => 'versionNotes' in guide)) {
      const notes = readMarkdown(await loadGuideSource(guide), guide.source).slice(0, 'versionNotes' in guide ? guide.versionNotes : 0)
      for (const block of notes) {
        expect(block.type, guide.source).toBe('html')
        if (block.type === 'html') expect(block.html, guide.source).toMatch(/\d+\.\d+\.\d+/)
      }
    }
  })

  it('loads a Portuguese catalog only for Portuguese readers of translated guides', async () => {
    const storage = guides.find(guide => guide.id === 'storage')
    const starter = guides.find(guide => guide.id === 'sdk-start')
    if (storage === undefined || starter === undefined) throw new Error('storage and sdk-start guides are registered')
    expect(await loadGuideTranslation(storage, 'en')).toBeUndefined()
    expect(await loadGuideTranslation(starter, 'pt-BR')).toBeUndefined()
    expect(Object.keys(await loadGuideTranslation(storage, 'pt-BR') ?? {}).length).toBeGreaterThan(0)
  })

  it('normalizes search text once per locale and guide', async () => {
    const auth = guides.find(guide => guide.id === 'auth')
    if (auth === undefined) throw new Error('auth guide is registered')
    expect(loadGuideSearchText(auth, 'pt-BR')).toBe(loadGuideSearchText(auth, 'pt-BR'))
    expect(loadGuideSearchText(auth, 'en')).not.toBe(loadGuideSearchText(auth, 'pt-BR'))
    const portuguese = await loadGuideSearchText(auth, 'pt-BR')
    expect(portuguese).toBe(portuguese.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase())
    expect(portuguese).toContain('nelcota_password_recovery_url')
  })

  it('keeps relative and GitHub documentation links in the panel, including sections', () => {
    expect(guideLink('api.md#errors', 'docs/storage.md')).toBe('/admin/guides/api?section=errors')
    expect(guideLink('docs/contract.md', 'sdk/typescript/README.md')).toBe('/admin/guides/sdk-contract')
    expect(guideLink('https://github.com/HanielCota/Nelcota/blob/main/docs/storage.md', 'sdk/typescript/README.md')).toBe('/admin/guides/storage')
    expect(guideLink('https://github.com/Nelcota/Nelcota/blob/main/docs/storage.md#signed-urls', 'sdk/typescript/README.md')).toBe('/admin/guides/storage?section=signed-urls')
    expect(guideLink('../examples/notes.sql', 'docs/quickstart.md')).toBe('/admin/guides/example')
    expect(guideLink('#errors', 'docs/api.md')).toBe('/admin/guides/api?section=errors')
    expect(guideLink('https://github.com/other/repo', 'docs/api.md')).toBeNull()
    expect(guideLink('operational-alerts.md', 'docs/panel.md')).toBe('https://github.com/Nelcota/Nelcota/blob/main/docs/operational-alerts.md')
    expect(guideLink('javascript:alert(1)', 'docs/api.md')).toBeNull()
    expect(guideLink('%invalid', 'docs/api.md')).toBeNull()
  })

  it('keeps the Notes staging recipe reachable outside the bundled reader', () => {
    const target = 'https://github.com/Nelcota/Nelcota/blob/main/docs/onboarding/notes.md#3-apply-the-notes-schema'
    expect(guideLink('onboarding/notes.md#3-apply-the-notes-schema', 'docs/quickstart.md')).toBe(target)
    const blocks = readMarkdown('[Notes staging](onboarding/notes.md#3-apply-the-notes-schema)', 'docs/quickstart.md')
    const html = blocks.filter(block => block.type === 'html').map(block => block.html).join('')
    expect(html).toContain(`href="${target}"`)
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  })
})

describe('guide reader', () => {
  it.each(['<script', '<<script>alert(1)</script>', '<scr<script>ipt>', '\" onfocus=\"alert(1)'])('limits anchor characters for malformed markup: %s', value => {
    expect(headingSlug(value)).toMatch(/^[\p{L}\p{N}_-]*$/u)
  })

  it('keeps existing Unicode, code and punctuation heading anchors', () => {
    expect(headingSlug('JWT e regras de acesso')).toBe('jwt-e-regras-de-acesso')
    expect(headingSlug('`getUser()` — configuração')).toBe('getuser--configuração')
  })

  it('keeps code copyable and gives duplicate headings distinct anchors', () => {
    const blocks = readMarkdown('# Title\n\n## Results and errors\n\n```ts\nconst value = "<script>"\n```\n\n## Results and errors', 'docs/api.md')
    expect(blocks.filter(block => block.type === 'heading').map(block => block.id)).toEqual(['results-and-errors', 'results-and-errors-1'])
    expect(blocks.find(block => block.type === 'code')).toEqual({ type: 'code', code: 'const value = "<script>"', lang: 'ts' })
  })

  it('renders scrollable tables and escapes raw HTML and unsafe links', () => {
    const blocks = readMarkdown('| Key | Value |\n| --- | --- |\n| a | b |\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert) [API](api.md)', 'docs/storage.md')
    const html = blocks.filter(block => block.type === 'html').map(block => block.html).join('')
    expect(html).toContain('class="guide-table"')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="/admin/guides/api"')
  })
})
