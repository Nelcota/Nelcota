/**
 * Makes stylesheet imports visible to the dependency graph.
 *
 * @param source - Stylesheet source, including optional import layers.
 * @returns JavaScript imports for local and package stylesheets.
 */
export function stylesheetImports(source: string): string {
  const uncommented = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...uncommented.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)];
  return imports
    .flatMap((match) => {
      const specifier = match[1];
      if (specifier === undefined || /^(?:https?:|data:|\/\/)/.test(specifier)) return [];
      return [`import ${JSON.stringify(specifier)};`];
    })
    .join("\n");
}
