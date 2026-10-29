import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { compileComponent, type Component } from "./component.ts";

function linkSiblings(original: string, mirror: string, excluded: string): void {
  mkdirSync(mirror, { recursive: true });
  for (const entry of readdirSync(original)) {
    if (entry === excluded || entry === ".git" || /^tsconfig.*\.json$/.test(entry)) continue;
    symlinkSync(join(original, entry), join(mirror, entry));
  }
}

function mirrorSource(source: string, destination: string): Map<string, Component> {
  const components = new Map<string, Component>();
  const names = Array.from(new Bun.Glob("**/*.{ts,js,json,svelte}").scanSync({ cwd: source }));
  for (const name of names) {
    const original = join(source, name);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    if (name.endsWith(".svelte") === false) {
      cpSync(original, target);
      continue;
    }
    if (names.includes(`${name}.ts`))
      throw new Error(`Component/Rune module collision: ${original}`);
    const component = compileComponent(original, readFileSync(original, "utf8"));
    writeFileSync(`${target}.ts`, component.generated);
    components.set(`${target}.ts`, component);
  }
  return components;
}

/**
 * Mirror source files while resolving external inputs against the real checkout.
 * Ancestor symlinks preserve relative imports without modifying code or its source map.
 */
export function createProject(
  root: string,
  temporary: string,
): {
  readonly source: string;
  readonly components: Map<string, Component>;
} {
  symlinkSync(join(root, "crates/admin/ui/node_modules"), join(temporary, "node_modules"));
  const parts = ["crates", "admin", "ui", "src"];
  let original = resolve(root);
  let mirror = join(temporary, "project");
  for (const part of parts) {
    linkSiblings(original, mirror, part);
    original = join(original, part);
    mirror = join(mirror, part);
  }
  const components = mirrorSource(original, mirror);
  if (components.size === 0)
    throw new Error(`No Svelte components found in ${relative(root, original)}`);
  return { source: mirror, components };
}
