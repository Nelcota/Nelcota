import ts from "typescript";

export type Insertion = { readonly offset: number; readonly text: string };

/** Model derived expressions as deferred callbacks, matching Svelte's runtime evaluation. */
export function deferDerived(code: string): { code: string; insertions: Insertion[] } {
  const source = ts.createSourceFile("component.ts", code, ts.ScriptTarget.Latest, true);
  const insertions: Insertion[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "$derived" &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument === undefined) throw new Error("Missing derived expression");
      insertions.push(
        { offset: node.expression.end, text: ".by" },
        { offset: argument.getStart(source), text: "() => (" },
        { offset: argument.end, text: ")" },
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let deferred = code;
  for (const insertion of insertions.toSorted((first, second) => second.offset - first.offset)) {
    deferred =
      deferred.slice(0, insertion.offset) + insertion.text + deferred.slice(insertion.offset);
  }
  return {
    code: deferred,
    insertions: insertions.toSorted((first, second) => first.offset - second.offset),
  };
}

/** Recover compiler offsets; inserted callback scaffolding has no user source location. */
export function compilerOffset(insertions: readonly Insertion[], offset: number): number | null {
  let added = 0;
  for (const insertion of insertions) {
    const start = insertion.offset + added;
    if (offset < start) break;
    if (offset < start + insertion.text.length) return null;
    added += insertion.text.length;
  }
  return offset - added;
}
