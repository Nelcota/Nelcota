// Route pattern matching, independent of the browser.

/** `/tables/notes` against the pattern `/tables/:name` → `{ name: 'notes' }`. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/')
  const s = path.split('/')
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      try { params[p[i].slice(1)] = decodeURIComponent(s[i]) } catch { return null }
      continue
    }
    if (p[i] !== s[i]) return null
  }
  return params
}
