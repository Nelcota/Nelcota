import { relative } from "node:path";

import { originalPositionFor } from "@jridgewell/trace-mapping";

import type { Diagnostic } from "../checks/diagnostics.ts";
import type { Component } from "./component.ts";
import { macroAssignments } from "./macros.ts";
import { compilerOffset } from "./reactivity.ts";

function originalOffset(source: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const end = source.indexOf("\n", offset);
    if (end === -1) throw new Error("Source map points outside the component");
    offset = end + 1;
  }
  return offset + column;
}

/** Keep diagnostics on user script expressions, preserving UTF-8 report locations. */
export function mapDiagnostic(component: Component, diagnostic: Diagnostic): Diagnostic | null {
  const span = diagnostic.labels[0]?.span;
  if (span === undefined) throw new Error("Typed component diagnostic has no location");
  const bytePrefix = Buffer.from(component.generated).subarray(0, span.offset).toString("utf8");
  const compilerStart = compilerOffset(component.insertions, bytePrefix.length);
  if (compilerStart === null) return null;
  const before = component.compilerCode.slice(0, compilerStart);
  const line = before.split("\n").length;
  const column = before.length - (before.lastIndexOf("\n") + 1);
  const position = originalPositionFor(component.map, { line, column });
  if (position.line === null) return null;
  const offset = originalOffset(component.source, position.line, position.column);
  if (component.scripts.some((script) => offset >= script.start && offset < script.end) === false)
    return null;
  if (
    diagnostic.code === "typescript(no-unsafe-assignment)" &&
    macroAssignments(component).some((range) => offset >= range.start && offset < range.end)
  )
    return null;
  const mappedSpan = {
    offset: Buffer.byteLength(component.source.slice(0, offset)),
    length: mappedLength(component, span.offset + span.length, offset),
    line: position.line,
    column: position.column + 1,
  };
  return {
    ...diagnostic,
    filename: relative(process.cwd(), component.file),
    labels: [{ span: mappedSpan }],
  };
}

function mappedLength(component: Component, generatedEnd: number, start: number): number {
  const bytePrefix = Buffer.from(component.generated).subarray(0, generatedEnd).toString("utf8");
  const compilerEnd = compilerOffset(component.insertions, bytePrefix.length);
  if (compilerEnd === null) return 1;
  const before = component.compilerCode.slice(0, compilerEnd);
  const position = originalPositionFor(component.map, {
    line: before.split("\n").length,
    column: before.length - (before.lastIndexOf("\n") + 1),
  });
  if (position.line === null) return 1;
  const end = originalOffset(component.source, position.line, position.column);
  return Math.max(1, Buffer.byteLength(component.source.slice(start, end)));
}
