import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { proseFragments, validateTranslations } from '../src/lib/features/guides/prose.ts'

const root = new URL('../../../../', import.meta.url)
const catalogRoot = new URL('docs/i18n/pt-BR/', root)
import { guides } from '../src/lib/features/guides/registry.ts'
const documents = Object.fromEntries(guides.filter(guide => guide.id !== 'openapi' && !('language' in guide) && !('code' in guide)).map(guide => [guide.id, guide.source]))

const mode = process.argv[2] ?? '--check'
const selected = process.argv[3]
let failures = 0
for (const [id, source] of Object.entries(documents)) {
  if (selected && selected !== id) continue
  const markdown = await readFile(new URL(source, root), 'utf8')
  const path = new URL(`${id}.json`, catalogRoot)
  let catalog = {}
  try { catalog = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const fragments = proseFragments(markdown)
  if (mode === '--extract') {
    console.log(JSON.stringify({ id, source, fragments }, null, 2))
    continue
  }
  if (mode === '--pending') {
    const pending = fragments.filter(fragment => !catalog[fragment])
    if (pending.length) console.log(JSON.stringify({ id, source, fragments: pending }, null, 2))
    continue
  }
  if (mode === '--import') {
    if (!selected) throw new Error('--import requires a guide id and a JSON array of translations')
    const values = JSON.parse(await readFile(process.argv[4], 'utf8'))
    if (values.length !== fragments.length) throw new Error(`${id}: expected ${fragments.length} translations, received ${values.length}`)
    catalog = Object.fromEntries(fragments.map((text, index) => [text, values[index]]))
    const errors = validateTranslations(markdown, catalog)
    if (errors.length) throw new Error(`${id}:\n${errors.join('\n')}`)
    await mkdir(catalogRoot, { recursive: true })
    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`)
    console.log(`Saved ${fileURLToPath(path)} (${fragments.length} fragments)`)
    continue
  }
  const errors = validateTranslations(markdown, catalog)
  for (const error of errors) console.error(`${source}: ${error}`)
  failures += errors.length
}
if (mode === '--check' && !selected) {
  // Track the exact prose emitted by the Rust generator, including templates.
  const source = await readFile(new URL('crates/api/src/openapi.rs', root), 'utf8')
  const catalog = JSON.parse(await readFile(new URL('openapi.json', catalogRoot), 'utf8'))
  const literal = '"((?:[^"\\\\]|\\\\.)*)"'
  const patterns = [
    new RegExp(`"(?:description|title)":\\s*${literal}`, 'g'),
    new RegExp(`json_response\\(${literal}`, 'g'),
    new RegExp(`(?:let mut description =|"description":)\\s*format!\\(\\s*${literal}`, 'g'),
  ]
  const fragments = new Set(patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => JSON.parse(`"${match[1]}"`))))
  for (const fragment of fragments) if (!Object.hasOwn(catalog, fragment) || !catalog[fragment]?.trim()) { console.error(`OpenAPI missing translation: ${fragment}`); failures++ }
  for (const fragment of Object.keys(catalog)) if (!fragments.has(fragment)) { console.error(`OpenAPI outdated translation: ${fragment}`); failures++ }
}
if (mode === '--check') {
  if (failures) { console.error(`Guide translations need updating (${failures} issues). Run bun run guides:pending.`); process.exitCode = 1 }
  if (!failures) console.log('All Portuguese guide translations match the project documentation; inline code and links are unchanged.')
}
