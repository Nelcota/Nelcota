import { expect, test } from "bun:test";

import { stylesheetImports } from "./imports.ts";

test("keeps package and relative stylesheet imports", () => {
  expect(
    stylesheetImports('@import "font-package"; @import url("./theme.css") layer(theme);'),
  ).toBe('import "font-package";\nimport "./theme.css";');
});

test("ignores commented and external stylesheet references", () => {
  expect(
    stylesheetImports('/* @import "unused"; */ @import "https://example.test/style.css";'),
  ).toBe("");
});
