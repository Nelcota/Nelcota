/** Quotes only when the name is not a plain lowercase identifier. */
export function quoteIfNeeded(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`
}
