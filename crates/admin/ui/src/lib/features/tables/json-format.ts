/** Pretty-print valid JSON without converting its number or string tokens. */
export function formatJson(value: string): string {
  JSON.parse(value) // Validate syntax; the parsed values are never serialized.
  const tokens = value.match(/"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) ?? []
  let depth = 0
  let result = ''
  // Cap visual indentation so a small, deeply nested value cannot expand
  // quadratically. All JSON tokens, including precise numbers, stay intact.
  const newline = () => { result += '\n' + '  '.repeat(Math.min(depth, 32)) }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{' || token === '[') {
      result += token
      depth++
      if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') newline()
      continue
    }
    if (token === '}' || token === ']') {
      depth--
      if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') newline()
      result += token
      continue
    }
    if (token === ',') {
      result += token
      newline()
      continue
    }
    result += token === ':' ? ': ' : token
  }
  return result
}
