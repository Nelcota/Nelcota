import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { proseFragments, validateTranslations } from "../src/lib/features/guides/prose.ts";
import { stringCatalog, translationText, translationList } from "./catalog-values.ts";

const root = new URL("../../../../", import.meta.url);
const catalogRoot = new URL("docs/i18n/pt-BR/", root);
import { guides } from "../src/lib/features/guides/registry.ts";
const documents = Object.fromEntries(
  guides
    .filter(
      (guide) =>
        guide.id !== "openapi" && "language" in guide === false && "code" in guide === false,
    )
    .map((guide) => [guide.id, guide.source]),
);

const [, , requestedMode, selected] = process.argv;
const mode = requestedMode ?? "--check";
let failures = 0;
for (const [id, source] of Object.entries(documents)) {
  if (selected != null && selected !== "" && selected !== id) continue;
  // oxlint-disable-next-line no-await-in-loop -- Keep per-guide diagnostics and catalog writes in registry order.
  failures += await processGuide(id, source);
}
if (mode === "--check" && (selected == null || selected === "")) failures += await checkOpenApi();
if (mode === "--check") {
  if (failures > 0) {
    console.error(
      `Guide translations need updating (${failures} issues). Run bun run guides:pending.`,
    );
    process.exitCode = 1;
  }
  if (failures === 0)
    console.log(
      "All Portuguese guide translations match the project documentation; inline code and links are unchanged.",
    );
}

async function readCatalog(path: URL): Promise<Record<string, string>> {
  try {
    return stringCatalog(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

async function importCatalog(id: string, markdown: string, path: URL): Promise<void> {
  if (selected == null || selected === "")
    throw new Error("--import requires a guide id and a JSON array of translations");
  const [, , , , translationsPath] = process.argv;
  if (translationsPath === undefined || translationsPath.trim() === "")
    throw new Error("--import requires the path of a JSON array of translations");
  const fragments = proseFragments(markdown);
  const values = translationList(JSON.parse(await readFile(translationsPath, "utf8")));
  if (values.length !== fragments.length)
    throw new Error(`${id}: expected ${fragments.length} translations, received ${values.length}`);
  const catalog = Object.fromEntries(
    fragments.map((text, index) => [text, translationText(values[index])]),
  );
  const errors = validateTranslations(markdown, catalog);
  if (errors.length > 0) throw new Error(`${id}:\n${errors.join("\n")}`);
  await mkdir(catalogRoot, { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Saved ${fileURLToPath(path)} (${fragments.length} fragments)`);
}

async function processGuide(id: string, source: string): Promise<number> {
  const markdown = await readFile(new URL(source, root), "utf8");
  const path = new URL(`${id}.json`, catalogRoot);
  const catalog = await readCatalog(path);
  const fragments = proseFragments(markdown);
  if (mode === "--extract") {
    console.log(JSON.stringify({ id, source, fragments }, null, 2));
    return 0;
  }
  if (mode === "--pending") {
    const pending = fragments.filter((fragment) => catalog[fragment] === "");
    if (pending.length > 0)
      console.log(JSON.stringify({ id, source, fragments: pending }, null, 2));
    return 0;
  }
  if (mode === "--import") {
    await importCatalog(id, markdown, path);
    return 0;
  }
  const errors = validateTranslations(markdown, catalog);
  for (const error of errors) console.error(`${source}: ${error}`);
  return errors.length;
}

async function checkOpenApi(): Promise<number> {
  let failures = 0;
  // Track the exact prose emitted by the Rust generator, including templates.
  const source = await readFile(new URL("crates/api/src/openapi.rs", root), "utf8");
  const catalog = stringCatalog(
    JSON.parse(await readFile(new URL("openapi.json", catalogRoot), "utf8")),
  );
  const literal = '"((?:[^"\\\\]|\\\\.)*)"';
  const patterns = [
    new RegExp(`"(?:description|title)":\\s*${literal}`, "g"),
    new RegExp(`json_response\\(${literal}`, "g"),
    new RegExp(`(?:let mut description =|"description":)\\s*format!\\(\\s*${literal}`, "g"),
  ];
  const fragments = new Set(
    patterns.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => translationText(JSON.parse(`"${match[1]}"`))),
    ),
  );
  for (const fragment of fragments)
    if (
      Object.hasOwn(catalog, fragment) === false ||
      Boolean(catalog[fragment]?.trim()) === false
    ) {
      console.error(`OpenAPI missing translation: ${fragment}`);
      failures++;
    }
  for (const fragment of Object.keys(catalog))
    if (fragments.has(fragment) === false) {
      console.error(`OpenAPI outdated translation: ${fragment}`);
      failures++;
    }
  return failures;
}
