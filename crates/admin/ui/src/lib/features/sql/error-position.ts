/**
 * Editor offset of a Postgres error position. Postgres counts the 1-based
 * position in characters of the query it ran; the editor and `String.slice`
 * count UTF-16 code units, where an emoji takes two.
 */
export function errorOffset(code: string, position: number): number | null {
  if (Number.isInteger(position) === false || position < 1) return null
  let units = 0
  let characters = 0
  for (const character of code) {
    if (characters === position - 1) return units
    units += character.length
    characters += 1
  }
  // A position just past the end points at the end of the text.
  return characters === position - 1 ? units : null
}
