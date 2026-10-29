import { requiredValue } from "$lib/contracts/required-value";
// These sources ship with the panel. Documentation changes are reflected on
// the next build, with no network request. Only prose has a translation catalog.
// Each file is its own chunk: opening a guide downloads only that guide, and
// its Portuguese catalog only for a Portuguese reader. Keep this list in sync
// with the registry (content.test.ts checks both directions).
const sources = import.meta.glob<string>(
  [
    "../../../../../../../docs/api.md",
    "../../../../../../../docs/architecture.md",
    "../../../../../../../docs/backup.md",
    "../../../../../../../docs/decisions.md",
    "../../../../../../../docs/deploy.md",
    "../../../../../../../docs/remote-migrations.md",
    "../../../../../../../docs/jwt-and-roles.md",
    "../../../../../../../docs/testing-rls.md",
    "../../../../../../../docs/leaving.md",
    "../../../../../../../docs/panel.md",
    "../../../../../../../docs/quickstart.md",
    "../../../../../../../docs/schema-auth.md",
    "../../../../../../../docs/storage.md",
    "../../../../../../../docs/troubleshooting.md",
    "../../../../../../../docs/webhooks.md",
    "../../../../../../../sdk/typescript/README.md",
    "../../../../../../../sdk/typescript/CHANGELOG.md",
    "../../../../../../../sdk/typescript/docs/contract.md",
    "../../../../../../../sdk/typescript/docs/quickstart.pt-BR.md",
    "../../../../../../../sdk/typescript/docs/releasing.md",
    "../../../../../../../sdk/rust/README.md",
    "../../../../../../../sdk/rust/docs/contract.md",
    "../../../../../../../sdk/rust/docs/quickstart.pt-BR.md",
    "../../../../../../../sdk/rust/docs/releasing.md",
    "../../../../../../../examples/notes.sql",
    "../../../../../../../sdk/typescript/examples/server.mjs",
  ],
  { query: "?raw", import: "default" },
);

import type { Locale } from "$lib/i18n/index.svelte";
import { normalizeSearchText } from "$lib/shell/search";

import { proseFragments, type TranslationCatalog } from "./prose";
import { guides, guidePath, type Guide, type GuideId } from "./registry";
export { guides, guideGroups, guidePath, type Guide, type GuideId } from "./registry";

// The OpenAPI catalog is imported directly by openapi-prose.ts.
const translations = import.meta.glob<TranslationCatalog>(
  [
    "../../../../../../../docs/i18n/pt-BR/*.json",
    "!../../../../../../../docs/i18n/pt-BR/openapi.json",
  ],
  { import: "default" },
);

const sourcePrefix = "../../../../../../../";

/** Repository paths of the bundled guide sources, for the registry consistency test. */
export const bundledSources = Object.keys(sources).map((path) => path.slice(sourcePrefix.length));

// A failed chunk download is not cached, so retrying fetches it again.
function remember<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

const loadedSources = new Map<string, Promise<string>>();
export function loadGuideSource(guide: Guide): Promise<string> {
  if (guide.id === "openapi") return Promise.resolve("");
  const load = sources[`${sourcePrefix}${guide.source}`];
  if (load === undefined) throw new Error(`Guide source is not bundled: ${guide.source}`);
  return remember(loadedSources, guide.id, load);
}

const loadedTranslations = new Map<string, Promise<TranslationCatalog>>();
export async function loadGuideTranslation(
  guide: Guide,
  locale: Locale,
): Promise<TranslationCatalog | undefined> {
  if (locale !== "pt-BR" || "language" in guide || "code" in guide || guide.id === "openapi")
    return undefined;
  const load = translations[`${sourcePrefix}docs/i18n/pt-BR/${guide.id}.json`];
  if (load === undefined) throw new Error(`Missing Portuguese guide: ${guide.source}`);
  return await remember(loadedTranslations, guide.id, load);
}

const searchTexts = new Map<string, Promise<string>>();
/**
 * Guide text for search, already normalized: the original source (code and
 * identifiers) plus its translated prose. Computed once per locale and guide.
 */
export function loadGuideSearchText(guide: Guide, locale: Locale): Promise<string> {
  return remember(searchTexts, `${locale}:${guide.id}`, async () => {
    const [source, catalog] = await Promise.all([
      loadGuideSource(guide),
      loadGuideTranslation(guide, locale),
    ]);
    if (catalog === undefined) return normalizeSearchText(source);
    const translated = proseFragments(source)
      .map((fragment) => catalog[fragment])
      .join("\n");
    return normalizeSearchText(`${source}\n${translated}`);
  });
}

/** Normalized search text of every guide in one locale, keyed by guide. */
export async function loadGuideSearchIndex(locale: Locale): Promise<ReadonlyMap<GuideId, string>> {
  const texts = await Promise.all(guides.map((guide) => loadGuideSearchText(guide, locale)));
  return new Map(guides.map((guide, index) => [guide.id, texts[index] ?? ""]));
}

function guideUrl(link: string, source: string): URL | null {
  try {
    const url = new URL(link, `https://nelcota.local/${source}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
function decodedPath(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname).replace(/^\//, "");
  } catch {
    return null;
  }
}
function repositoryPath(path: string): string | null {
  // Keep links from documentation published before the organization transfer.
  const prefix = ["Nelcota/Nelcota/", "HanielCota/Nelcota/"].find((entry) =>
    path.startsWith(entry),
  );
  return prefix === undefined
    ? null
    : path.slice(prefix.length).replace(/^(?:blob|tree)\/[^/]+\//, "");
}
function embeddedLink(path: string, fragment: string): string | null {
  const guide = guides.find((entry) => entry.source === path);
  return guide === undefined ? null : `/admin${guidePath(guide.id, fragment)}`;
}
function sourceLink(path: string, hash: string): string | null {
  const embedded = embeddedLink(path, hash.slice(1));
  if (embedded !== null) return embedded;
  // Longer operational references stay outside the embedded reader.
  if (["docs/onboarding/notes.md", "docs/operational-alerts.md"].includes(path))
    return `https://github.com/Nelcota/Nelcota/blob/main/${path}${hash}`;
  if (path === "sdk/typescript/examples/") return "/admin/guides/example";
  if (path === "scripts/install.sh") return "/admin/guides/quickstart";
  return null;
}
/** Resolve repository documentation links into the reader, including GitHub URLs. */
export function guideLink(link: string, source: string): string | null {
  if (link.startsWith("#")) return embeddedLink(source, link.slice(1));
  const url = guideUrl(link, source);
  if (url === null) return null;
  let path = decodedPath(url);
  if (path === null) return null;
  if (url.hostname !== "github.com" && url.hostname !== "nelcota.local") return url.href;
  if (url.hostname === "github.com") {
    path = repositoryPath(path);
    if (path === null) return null;
    if (path === "") return "/admin/guides";
  }
  return sourceLink(path, url.hash);
}

/** Selects the requested guide or the locale's introductory guide. */
export function selectedGuide(path: string, locale: Locale): Guide {
  return (
    guides.find((guide) => path === guidePath(guide.id)) ??
    requiredValue(
      guides.find((guide) => guide.id === (locale === "pt-BR" ? "sdk-start" : "quickstart")),
      "selected entry",
    )
  );
}
