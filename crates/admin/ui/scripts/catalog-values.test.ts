import { expect, it } from "vitest";

import { missingTranslations, stringCatalog, translationList } from "./catalog-values.ts";

it("pending translations include missing, empty and whitespace-only entries", () => {
  const fragments = ["new paragraph", "empty", "whitespace", "translated"];
  expect(
    missingTranslations(fragments, { empty: "", whitespace: " \n\t", translated: "Traduzido" }),
  ).toEqual(["new paragraph", "empty", "whitespace"]);
  expect(missingTranslations(["translated"], { translated: "Texto" })).toEqual([]);
});

it("translation inputs still reject malformed values rather than overwrite catalogs", () => {
  expect(() => stringCatalog({ source: 42 })).toThrow(TypeError);
  expect(() => translationList(["valid", null])).toThrow(TypeError);
});
