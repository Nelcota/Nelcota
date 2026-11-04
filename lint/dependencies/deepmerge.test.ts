import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Merge = (
  target: object,
  source: object,
  options?: { arrayMerge: (target: unknown[], source: unknown[]) => unknown[] },
) => Record<PropertyKey, unknown>;

const root = fileURLToPath(new URL("../../", import.meta.url));

function parseObject(input: string): object {
  const value: unknown = JSON.parse(input);
  if (typeof value !== "object" || value === null) throw new Error("Expected an object fixture");
  return value;
}

for (const project of ["crates/admin/ui", "sdk/ssr/examples/sveltekit"]) {
  const projectRequire = createRequire(join(root, project, "package.json"));
  const pluginRequire = createRequire(projectRequire.resolve("@sveltejs/vite-plugin-svelte"));
  const directory = dirname(pluginRequire.resolve("deepmerge"));

  for (const filename of ["cjs.js", "umd.js"]) {
    // Resolve through the consumer so a missing patch in either lockfile fails this check.
    const merge = pluginRequire(join(directory, filename)) as Merge;

    describe(`${project}: deepmerge ${filename} prototype safety`, () => {
      test("copying an own __proto__ key from the target cannot poison the result", () => {
        const target = parseObject('{"__proto__":{"isAdmin":true}}');
        const result = merge(target, {});
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(result["isAdmin"]).toBeUndefined();
        expect(Object.hasOwn(result, "__proto__")).toBe(true);
        expect(result["__proto__"]).toEqual({ isAdmin: true });
      });

      test("merging into a null-prototype target cannot poison the result", () => {
        const source = parseObject('{"__proto__":{"isAdmin":true}}');
        const result = merge(Object.create(null) as object, source);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(result["isAdmin"]).toBeUndefined();
        expect(result["__proto__"]).toEqual({ isAdmin: true });
      });

      test("merging two own __proto__ values cannot poison the result", () => {
        const result = merge(
          parseObject('{"__proto__":{"retained":true}}'),
          parseObject('{"__proto__":{"isAdmin":true}}'),
        );
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(result["isAdmin"]).toBeUndefined();
        expect(result["__proto__"]).toEqual({ retained: true, isAdmin: true });
      });
    });

    describe(`${project}: deepmerge ${filename} configuration compatibility`, () => {
      test("recursive clones and array elements retain their ordinary prototypes", () => {
        const target = parseObject(
          '{"nested":{"__proto__":{"isAdmin":true}},"items":[{"__proto__":{"isAdmin":true}}]}',
        );
        const result = merge(target, {});
        const nested = result["nested"] as Record<string, unknown>;
        const items = result["items"] as Record<string, unknown>[];
        expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
        expect(nested["isAdmin"]).toBeUndefined();
        expect(Object.getPrototypeOf(items[0])).toBe(Object.prototype);
        expect(items[0]?.["isAdmin"]).toBeUndefined();
      });

      test("keeps Svelte's array replacement, nested options and symbol keys", () => {
        const key = Symbol("option");
        const result = merge(
          { compilerOptions: { dev: true }, extensions: [".svelte"], [key]: "kept" },
          { compilerOptions: { css: "external" }, extensions: [".custom"] },
          { arrayMerge: (_target, source) => source },
        );
        expect(result).toEqual({
          compilerOptions: { dev: true, css: "external" },
          extensions: [".custom"],
          [key]: "kept",
        });
      });
    });
  }
}
