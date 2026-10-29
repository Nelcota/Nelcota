import { TraceMap } from "@jridgewell/trace-mapping";
import { parse } from "svelte/compiler";
import { svelte2tsx } from "svelte2tsx";

import { deferDerived, type Insertion } from "./reactivity.ts";

export type SourceRange = { readonly start: number; readonly end: number };
export type Component = {
  readonly file: string;
  readonly source: string;
  readonly generated: string;
  readonly compilerCode: string;
  readonly insertions: readonly Insertion[];
  readonly map: TraceMap;
  readonly scripts: readonly SourceRange[];
};

function scriptRange(value: unknown): SourceRange {
  if (typeof value !== "object" || value === null) throw new Error("Missing Svelte script range");
  const start: unknown = Reflect.get(value, "start");
  const end: unknown = Reflect.get(value, "end");
  if (typeof start !== "number" || typeof end !== "number")
    throw new Error("Invalid Svelte script range");
  return { start, end };
}

/** Convert with the same official compiler used by Svelte's language tooling. */
export function compileComponent(file: string, source: string): Component {
  const ast = parse(source, { modern: true });
  const result = svelte2tsx(source, { filename: file, isTsFile: true });
  const scripts = [ast.instance?.content, ast.module?.content]
    .filter((script) => script !== undefined)
    .map(scriptRange);
  const deferred = deferDerived(result.code);
  return {
    file,
    source,
    generated: deferred.code,
    compilerCode: result.code,
    insertions: deferred.insertions,
    map: new TraceMap(JSON.stringify(result.map)),
    scripts,
  };
}
