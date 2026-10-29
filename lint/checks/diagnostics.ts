type Span = {
  readonly offset: number;
  readonly length: number;
  readonly line: number;
  readonly column: number;
};

export type Diagnostic = {
  readonly code: string;
  readonly filename: string;
  readonly message: string;
  readonly severity: string;
  readonly labels: readonly { readonly span: Span }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLabel(value: unknown): value is { span: Span } {
  if (record(value) === false || record(value["span"]) === false) return false;
  const span = value["span"];
  return ["offset", "length", "line", "column"].every(
    (name) => typeof span[name] === "number" && Number.isSafeInteger(span[name]),
  );
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (record(value) === false) return false;
  return (
    ["code", "filename", "message", "severity"].every((name) => typeof value[name] === "string") &&
    Array.isArray(value["labels"]) &&
    value["labels"].every(isLabel)
  );
}

/** Reject malformed linter output instead of treating an incomplete run as success. */
export function readDiagnostics(output: string): Diagnostic[] {
  const report: unknown = JSON.parse(output);
  if (
    record(report) === false ||
    Array.isArray(report["diagnostics"]) === false ||
    report["diagnostics"].every(isDiagnostic) === false
  ) {
    throw new Error("Oxlint returned an invalid diagnostic report");
  }
  return report["diagnostics"];
}
