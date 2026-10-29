import { Lexer, Marked, type TokensList, type Tokens } from "marked";
import { expect, it } from "vitest";

import { guides, loadGuideSource, loadGuideTranslation, loadGuideSearchText } from "./content";
import { readMarkdown } from "./markdown";
import { proseFragments, translateTokens, validateTranslations } from "./prose";

function examples(tokens: TokensList) {
  const code: string[] = [],
    inline: string[] = [],
    links: string[] = [];
  void new Marked().walkTokens(tokens, (token) => {
    if (token.type === "code") code.push(`${token.lang ?? ""}\n${token.text}`);
    if (token.type === "codespan") inline.push((token as Tokens.Codespan).text);
    if (token.type === "link" || token.type === "image")
      links.push((token as Tokens.Link | Tokens.Image).href);
  });
  return { code, inline: inline.toSorted(), links: links.toSorted() };
}

for (const guide of guides.filter(
  (guide) => "language" in guide === false && "code" in guide === false && guide.id !== "openapi",
)) {
  it(`Portuguese guide contracts > translates ${guide.id} with unchanged code, links and section URLs`, async () => {
    const source = await loadGuideSource(guide),
      catalog = await loadGuideTranslation(guide, "pt-BR");
    if (catalog === undefined) throw new Error(`Missing Portuguese catalog: ${guide.id}`);
    expect(validateTranslations(source, catalog)).toEqual([]);
    const tokens = Lexer.lex(source),
      original = examples(tokens);
    const translated = translateTokens(tokens, catalog);
    expect(examples(translated)).toEqual(original);
    const english = readMarkdown(source, guide.source);
    const portuguese = readMarkdown(source, guide.source, catalog);
    expect(portuguese.filter((block) => block.type === "code")).toEqual(
      english.filter((block) => block.type === "code"),
    );
    expect(portuguese.filter((block) => block.type === "heading").map((block) => block.id)).toEqual(
      english.filter((block) => block.type === "heading").map((block) => block.id),
    );
    expect(await loadGuideTranslation(guide, "en")).toBeUndefined();
  });
}

it("Portuguese guide contracts > detects prose drift but immediately accepts updated source code", () => {
  const source =
    "# Guide\n\nUse `createClient()` and [API](api.md).\n\n```ts\n// Leave this comment alone\nconst value = 1\n```";
  const catalog = {
    Guide: "Guia",
    "Use `createClient()` and [API](api.md).": "Use `createClient()` e [API](api.md).",
  };
  expect(validateTranslations(source, catalog)).toEqual([]);
  expect(validateTranslations(source.replace("value = 1", "value = 2"), catalog)).toEqual([]);
  expect(validateTranslations(source.replace("Use `", "Call `"), catalog)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Missing translation"),
      expect.stringContaining("Outdated translation"),
    ]),
  );
  for (const changed of [
    "Use `other()` e [API](api.md).",
    "Use `createClient()` e [API](elsewhere.md).",
  ]) {
    expect(
      validateTranslations(source, {
        ...catalog,
        "Use `createClient()` and [API](api.md).": changed,
      }),
    ).toContainEqual(expect.stringContaining("Changed inline code or link"));
  }
});

it("Portuguese guide contracts > translates nested lists, quotes and table prose without touching their examples", () => {
  const source =
    '> A note with `code`.\n\n- First item\n  - Second item\n\n  ```sh\n  echo "English example"\n  ```\n\n| Column | Type |\n|---|---|\n| Name | `text` |';
  expect(proseFragments(source)).toEqual([
    "A note with `code`.",
    "First item",
    "Second item",
    "Column",
    "Type",
    "Name",
  ]);
  const tokens = Lexer.lex(source),
    original = examples(tokens);
  const translated = translateTokens(tokens, {
    "A note with `code`.": "Uma nota com `code`.",
    "First item": "Primeiro item",
    "Second item": "Segundo item",
    Column: "Coluna",
    Type: "Tipo",
    Name: "Nome",
  });
  const html = new Marked().parser(translated);
  expect(html).toContain("Segundo item");
  expect(html).toContain("Uma nota");
  expect(html).toContain("<th>Coluna</th>");
  expect(examples(translated)).toEqual(original);
});

it("Portuguese guide contracts > preserves source tokens and reference definitions when translating", () => {
  const tokens = Lexer.lex(
    "# Source guide\n\nKeep `code` and [API](api.md).\n\n[reference]: reference.md",
  );
  const original = structuredClone(tokens);
  const translated = translateTokens(tokens, {
    "Source guide": "Translated guide",
    "Keep `code` and [API](api.md).": "Preserve `code` and [API](api.md).",
  });
  expect(tokens).toEqual(original);
  expect(translated).not.toBe(tokens);
  expect(translated.links).toEqual(original.links);
  expect(new Marked().parser(translated)).toContain("Translated guide");
  expect(examples(translated)).toEqual(examples(tokens));
});

it("Portuguese guide contracts > searches Portuguese prose and original technical identifiers", async () => {
  const auth = guides.find((guide) => guide.id === "auth");
  const starter = guides.find((guide) => guide.id === "sdk-start");
  if (auth === undefined || starter === undefined)
    throw new Error("auth and sdk-start guides are registered");
  expect(await loadGuideSearchText(auth, "pt-BR")).toContain("caixa de entrada");
  expect(await loadGuideSearchText(auth, "pt-BR")).toContain("nelcota_password_recovery_url");
  expect(await loadGuideSearchText(auth, "en")).not.toContain("caixa de entrada");
  expect(await loadGuideTranslation(starter, "pt-BR")).toBeUndefined();
});
