import { checkSvelte } from "../svelte/check.ts";
import { runOxlint } from "./oxlint.ts";

const arguments_ = process.argv.slice(2);
const supported = new Set(["--fix", "--format", "json"]);
if (arguments_.some((argument) => supported.has(argument) === false)) {
  throw new Error("Supported lint options: --fix, --format json");
}
const native = runOxlint([
  "--config",
  ".nelcota-rules.oxlintrc.json",
  "--ignore-path",
  ".oxlintignore",
  "--disable-nested-config",
  "--threads",
  "2",
  "--type-aware",
  "--format",
  "json",
  ...(arguments_.includes("--fix") ? ["--fix"] : []),
  "crates/admin/ui",
  "sdk/typescript",
  "sdk/nextjs",
  "sdk/ssr",
  "lint",
  "knip.config.ts",
]);
const diagnostics = [...native, ...checkSvelte(process.cwd())];
if (arguments_.includes("json")) {
  console.log(JSON.stringify({ diagnostics }));
} else {
  for (const diagnostic of diagnostics) {
    const span = diagnostic.labels[0]?.span;
    console.log(
      `${diagnostic.filename}:${span?.line ?? 1}:${span?.column ?? 1} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  console.log(`${diagnostics.length} lint diagnostics`);
}
process.exitCode = diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
