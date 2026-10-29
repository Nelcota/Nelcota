import { dirname, join } from "node:path";

// CLAUDE.md asks to split a package into sub-packages once it passes about 10 files.
const MAX_SOURCE_FILES_PER_PACKAGE = 10;

type OversizedPackage = {
  readonly directory: string;
  readonly fileCount: number;
};

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|svelte)$/;
const TEST_FILE = /\.(?:test(?:-d)?|spec)\.[cm]?[jt]sx?$/;

function isSourceFile(filePath: string): boolean {
  return SOURCE_FILE.test(filePath) && TEST_FILE.test(filePath) === false;
}

/**
 * Finds folders that hold more source files than a package should.
 *
 * @remarks
 * Only files directly inside a folder count; sub-packages are counted on their own.
 * Counts JavaScript, TypeScript and Svelte source files. Test files are ignored because they sit
 * next to the file they test.
 *
 * @param filePaths - File paths relative to the project root.
 * @param maxFiles - Highest number of source files allowed per folder. Must be a positive integer.
 * @returns Each folder above the limit with its source file count, sorted by folder.
 * @throws {RangeError} When `maxFiles` is not a positive integer.
 */
export function findOversizedPackages(
  filePaths: readonly string[],
  maxFiles: number,
): OversizedPackage[] {
  if (Number.isInteger(maxFiles) === false || maxFiles < 1) {
    throw new RangeError(`maxFiles must be a positive integer, received ${maxFiles}`);
  }

  const filesByDirectory = Map.groupBy(filePaths.filter(isSourceFile), (filePath) =>
    dirname(filePath),
  );
  const oversized: OversizedPackage[] = [];
  for (const [directory, files] of filesByDirectory) {
    if (files.length > maxFiles) {
      oversized.push({ directory, fileCount: files.length });
    }
  }
  return oversized.toSorted((first, second) => first.directory.localeCompare(second.directory));
}

const sourceRoots = [
  "crates/admin/ui/src",
  "sdk/typescript/src",
  "sdk/ssr/src",
  "sdk/nextjs/src",
  "lint",
];

/** Read every declared source root; an empty match is a configuration error. */
export async function scanSourceFiles(roots: readonly string[]): Promise<string[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,svelte}");
  const groups = await Promise.all(
    roots.map(async (root) => {
      const files = await Array.fromAsync(glob.scan({ cwd: root }));
      if (files.length === 0) throw new Error(`No source files found in ${root}`);
      return files.map((file) => join(root, file));
    }),
  );
  return groups.flat();
}

if (import.meta.main) {
  const filePaths = await scanSourceFiles(sourceRoots);
  const oversized = findOversizedPackages(
    filePaths.filter((file) => file.startsWith("crates/admin/ui/src/lib/generated/") === false),
    MAX_SOURCE_FILES_PER_PACKAGE,
  );
  for (const { directory, fileCount } of oversized) {
    console.error(
      `${directory} has ${fileCount} source files (max ${MAX_SOURCE_FILES_PER_PACKAGE}). Split it into sub-packages by subject.`,
    );
  }
  process.exitCode = oversized.length === 0 ? 0 : 1;
}
