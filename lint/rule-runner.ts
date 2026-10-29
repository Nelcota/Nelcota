import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { runOxlint } from "./checks/oxlint.ts";

type LintCase = {
  readonly fileName: string;
  readonly code: string;
};

type LintBatch = {
  readonly pluginFile: string;
  readonly ruleId: string;
  readonly cases: readonly LintCase[];
};

async function createTemporaryDirectory(): Promise<AsyncDisposable & { path: string }> {
  const path = await mkdtemp(join(tmpdir(), "lint-rule-"));
  return {
    path,
    [Symbol.asyncDispose]: async () => await rm(path, { recursive: true, force: true }),
  };
}

function assertValidCases(cases: readonly LintCase[]): void {
  if (cases.length === 0) {
    throw new Error("Expected at least one lint case, received none");
  }
  const fileNames = new Set(cases.map((lintCase) => lintCase.fileName));
  if (fileNames.size !== cases.length) {
    throw new Error(`Lint case file names must be unique, received ${cases.length} cases`);
  }
}

/**
 * Turns a file path reported by oxlint into the case file name it was written from.
 *
 * @remarks
 * Case file names use "/" on every platform, while `relative` returns "\\" on Windows.
 *
 * @param directoryPath - Temporary directory the cases were written to.
 * @param reportedPath - Absolute file path from an oxlint diagnostic.
 * @returns The path relative to the directory, with "/" as separator.
 */
export function toCaseFileName(directoryPath: string, reportedPath: string): string {
  return relative(directoryPath, reportedPath).replaceAll("\\", "/");
}

/**
 * Lints every case with a single custom rule in one oxlint run and counts the errors per file.
 *
 * @remarks
 * RuleTester from oxlint does not run on Bun, so the rule is exercised through the oxlint CLI.
 * All cases share one run because starting oxlint once per case made the suite several times slower.
 *
 * @param batch - Plugin file inside `lint/`, rule id as `plugin/rule`, and the cases to lint.
 *   Each case file name is relative to a temporary directory and may include folders.
 * @returns Error count for each case, keyed by its file name.
 * @throws {Error} When there are no cases, file names repeat, or oxlint output is not the expected JSON.
 */
export async function countRuleErrorsByFile(batch: LintBatch): Promise<Map<string, number>> {
  assertValidCases(batch.cases);
  await using directory = await createTemporaryDirectory();
  const configPath = join(directory.path, ".oxlintrc.json");
  const config = {
    jsPlugins: [join(import.meta.dir, batch.pluginFile)],
    rules: { [batch.ruleId]: "error" },
  };
  await Promise.all([
    Bun.write(configPath, JSON.stringify(config)),
    ...batch.cases.map((lintCase) =>
      Bun.write(join(directory.path, lintCase.fileName), lintCase.code),
    ),
  ]);

  const diagnostics = runOxlint([
    "-c",
    configPath,
    "--format",
    "json",
    "--threads",
    "2",
    directory.path,
  ]);

  const [pluginName, ruleName] = batch.ruleId.split("/");
  const diagnosticCode = `${pluginName}(${ruleName})`;
  const errorCounts = new Map(batch.cases.map((lintCase) => [lintCase.fileName, 0]));
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== diagnosticCode) {
      continue;
    }
    const fileName = toCaseFileName(directory.path, diagnostic.filename);
    const currentCount = errorCounts.get(fileName);
    if (currentCount == null) {
      throw new Error(`oxlint reported a file that is not a lint case: ${fileName}`);
    }
    errorCounts.set(fileName, currentCount + 1);
  }
  return errorCounts;
}
