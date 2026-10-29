import ts from "typescript";

import type { Component, SourceRange } from "./component.ts";

function isMacro(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function bindingDefaults(name: ts.BindingName): SourceRange[] {
  if (ts.isObjectBindingPattern(name) === false) return [];
  return name.elements.flatMap((element) => {
    const value = element.initializer;
    if (isMacro(value, "$bindable") === false || value.arguments.length !== 0) return [];
    return [{ start: value.getStart(), end: value.end }];
  });
}

/**
 * Identify only the compiler's untyped macro values inside explicitly typed props.
 * Svelte's compiler validates their actual binding types; unrelated any values remain linted.
 */
export function macroAssignments(component: Component): SourceRange[] {
  return component.scripts.flatMap((script) => {
    const prefix = component.source.slice(0, script.start).replaceAll(/[^\n]/g, " ");
    const source = ts.createSourceFile(
      component.file,
      prefix + component.source.slice(script.start, script.end),
      ts.ScriptTarget.Latest,
      true,
    );
    const ranges: SourceRange[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        node.type !== undefined &&
        isMacro(node.initializer, "$props")
      ) {
        ranges.push(
          { start: node.initializer.getStart(), end: node.initializer.end },
          ...bindingDefaults(node.name),
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return ranges;
  });
}
