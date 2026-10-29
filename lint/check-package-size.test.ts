import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findOversizedPackages, scanSourceFiles } from "./check-package-size.ts";

function sourceFiles(directory: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${directory}/file-${index}.ts`);
}

describe("findOversizedPackages", () => {
  test("returns nothing when every folder is at the limit", () => {
    const filePaths = sourceFiles("src/orders", 3);

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([]);
  });

  test("reports a folder with more source files than the limit", () => {
    const filePaths = sourceFiles("src/orders", 4);

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([{ directory: "src/orders", fileCount: 4 }]);
  });
});

describe("findOversizedPackages file types", () => {
  test("ignores test files when counting", () => {
    const filePaths = [...sourceFiles("src/orders", 3), "src/orders/order.service.test.ts"];

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([]);
  });

  test("counts tsx files as source files", () => {
    const filePaths = [...sourceFiles("src/orders", 3), "src/orders/order-card.tsx"];

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([{ directory: "src/orders", fileCount: 4 }]);
  });

  test("ignores spec and tsx test files when counting", () => {
    const filePaths = [
      ...sourceFiles("src/orders", 3),
      "src/orders/order.spec.ts",
      "src/orders/order-card.test.tsx",
    ];

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([]);
  });
});

describe("monorepo source coverage", () => {
  test("counts JavaScript and Svelte files in their owning package", () => {
    expect(
      findOversizedPackages(
        [
          "sdk/ssr/src/context.ts",
          "sdk/ssr/src/fixture.mjs",
          "sdk/ssr/src/context.test.mjs",
          "sdk/ssr/src/contracts.test-d.ts",
          "crates/admin/ui/src/app.svelte",
          "crates/admin/ui/src/theme-init.js",
        ],
        1,
      ),
    ).toEqual([
      { directory: "crates/admin/ui/src", fileCount: 2 },
      { directory: "sdk/ssr/src", fileCount: 2 },
    ]);
  });
});

describe("findOversizedPackages folders", () => {
  test("counts sub-packages separately from their parent", () => {
    const filePaths = [...sourceFiles("src/orders", 3), ...sourceFiles("src/orders/payment", 3)];

    const oversized = findOversizedPackages(filePaths, 3);

    expect(oversized).toEqual([]);
  });

  test("returns oversized folders sorted by path", () => {
    const filePaths = [...sourceFiles("src/orders", 2), ...sourceFiles("src/customers", 2)];

    const oversized = findOversizedPackages(filePaths, 1);

    expect(oversized.map((entry) => entry.directory)).toEqual(["src/customers", "src/orders"]);
  });
});

describe("findOversizedPackages edge cases", () => {
  test("returns nothing when there are no files", () => {
    const oversized = findOversizedPackages([], 3);

    expect(oversized).toEqual([]);
  });

  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws RangeError when maxFiles is %p",
    (maxFiles) => {
      const action = () => findOversizedPackages([], maxFiles);

      expect(action).toThrow(RangeError);
    },
  );
});

describe("source root scanning", () => {
  test("finds actual JavaScript and Svelte sources in each declared root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nelcota-source-scan-"));
    try {
      const names = ["entry.js", "fixture.mjs", "page.svelte", "types.ts", "card.tsx"];
      await Promise.all(names.map((name) => writeFile(join(root, name), "")));
      const files = await scanSourceFiles([root]);
      expect(files.toSorted()).toEqual(names.map((name) => join(root, name)).toSorted());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a source root that would silently check nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "nelcota-empty-source-"));
    try {
      const failure = await scanSourceFiles([root]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure instanceof Error ? failure.message : "").toContain("No source files found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
