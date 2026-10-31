import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readDiagnostics, type Diagnostic } from "./diagnostics.ts";

// The package's bin is a Node script that Unix runs through its shebang.
// Windows cannot execute it directly, so run it with Node on every platform.
const script = fileURLToPath(new URL("../../node_modules/oxlint/bin/oxlint", import.meta.url));
const MAX_REPORT_BYTES = 16_777_216;

/** Run the pinned local binary and fail on configuration or process errors. */
export function runOxlint(arguments_: readonly string[]): Diagnostic[] {
  const result = spawnSync("node", [script, ...arguments_], {
    encoding: "utf8",
    maxBuffer: MAX_REPORT_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Oxlint failed (${result.status}): ${result.stderr}`);
  }
  let diagnostics: Diagnostic[];
  try {
    diagnostics = readDiagnostics(result.stdout);
  } catch (cause: unknown) {
    throw new Error(
      `Invalid Oxlint report (${result.stdout.length} characters): ${result.stderr}`,
      { cause },
    );
  }
  if (result.status === 1 && diagnostics.length === 0) {
    throw new Error(`Oxlint failed without diagnostics: ${result.stderr}`);
  }
  return diagnostics;
}
