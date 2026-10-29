import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Diagnostic } from "../checks/diagnostics.ts";
import { runOxlint } from "../checks/oxlint.ts";
import { writeConfiguration } from "./configuration.ts";
import { mapDiagnostic } from "./mapping.ts";
import { createProject } from "./project.ts";

/** Check script expressions omitted by Oxlint's native Svelte type-aware mode. */
export function checkSvelte(root: string): Diagnostic[] {
  const temporary = mkdtempSync(join(tmpdir(), "nelcota-svelte-lint-"));
  try {
    const project = createProject(root, temporary);
    const arguments_ = writeConfiguration(root, temporary, project.source);
    return runOxlint([...arguments_, ...project.components.keys()]).flatMap((diagnostic) => {
      const component = project.components.get(resolve(diagnostic.filename));
      if (component === undefined)
        throw new Error(
          `Unexpected Svelte lint target: ${diagnostic.filename}: ${diagnostic.message}`,
        );
      const mapped = mapDiagnostic(component, diagnostic);
      return mapped === null ? [] : [mapped];
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
