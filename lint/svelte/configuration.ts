import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import profile from "../../.nelcota-rules.oxlintrc.json" with { type: "json" };

/** Inherit the real Svelte configuration and compiler shims, retaining all typed profile rules. */
export function writeConfiguration(root: string, temporary: string, source: string): string[] {
  const shim = fileURLToPath(new URL(".", import.meta.resolve("svelte2tsx/package.json")));
  const tsconfig = join(source, "..", "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: join(root, "crates/admin/ui/tsconfig.app.json"),
      compilerOptions: {
        paths: { $lib: [join(source, "lib")], "$lib/*": [join(source, "lib/*")] },
        allowImportingTsExtensions: true,
        tsBuildInfoFile: join(temporary, ".tsbuildinfo"),
      },
      include: [
        join(source, "**/*.ts"),
        join(source, "**/*.js"),
        join(shim, "svelte-shims-v4.d.ts"),
        join(shim, "svelte-jsx-v4.d.ts"),
      ],
    }),
  );
  const config = join(temporary, "oxlint.json");
  const rules = Object.fromEntries(
    Object.entries(profile.rules).filter(([name]) => name.startsWith("typescript/")),
  );
  writeFileSync(
    config,
    JSON.stringify({
      plugins: ["typescript"],
      categories: Object.fromEntries(
        ["correctness", "suspicious", "pedantic", "style", "restriction", "nursery", "perf"].map(
          (name) => [name, "off"],
        ),
      ),
      rules,
    }),
  );
  return [
    "--config",
    config,
    "--tsconfig",
    tsconfig,
    "--disable-nested-config",
    "--threads",
    "2",
    "--type-aware",
    "--format",
    "json",
  ];
}
