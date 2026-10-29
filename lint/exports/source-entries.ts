/**
 * Maps published JavaScript exports to their source entry points.
 *
 * @param value - Package export map or one of its conditional branches.
 * @returns Source entries, excluding declarations and non-code metadata.
 */
export function sourceEntries(value: unknown): string[] {
  if (typeof value === "string") {
    if (value.startsWith("./dist/") === false || value.endsWith(".js") === false) return [];
    return [value.replace("./dist/", "src/").replace(/\.js$/, ".ts")];
  }
  if (value === null || typeof value !== "object") return [];
  return [...new Set(Object.values(value).flatMap(sourceEntries))];
}
