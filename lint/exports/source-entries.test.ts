import { expect, test } from "bun:test";

import { sourceEntries } from "./source-entries.ts";

test("preserves conditional and subpath public entry points", () => {
  expect(
    sourceEntries({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./browser": { types: "./dist/browser.d.ts", default: "./dist/browser.js" },
      "./package.json": "./package.json",
    }),
  ).toEqual(["src/index.ts", "src/browser.ts"]);
});

test("deduplicates exports and ignores non-code values", () => {
  expect(
    sourceEntries({ import: "./dist/index.js", default: "./dist/index.js", fallback: null }),
  ).toEqual(["src/index.ts"]);
  expect(sourceEntries(undefined)).toEqual([]);
});
