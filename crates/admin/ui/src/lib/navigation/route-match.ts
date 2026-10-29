// Route pattern matching, independent of the browser.

type RouteParam<Pattern extends string> = string extends Pattern
  ? string
  : Pattern extends `${string}:${infer Name}/${infer Rest}`
    ? Name | RouteParam<Rest>
    : Pattern extends `${string}:${infer Name}`
      ? Name
      : never;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `/tables/notes` against the pattern `/tables/:name` → `{ name: 'notes' }`. */
export function match<Pattern extends string>(
  pattern: Pattern,
  path: string,
): Record<RouteParam<Pattern>, string> | null {
  const p = pattern.split("/");
  const s = path.split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of p.entries()) {
    const segment = s[i];
    if (segment === undefined) return null;
    const parameter = part.startsWith(":");
    if (parameter === false && part !== segment) return null;
    if (parameter === false) continue;
    const decoded = decodeSegment(segment);
    if (decoded === null) return null;
    params[part.slice(1)] = decoded;
  }
  return params;
}
