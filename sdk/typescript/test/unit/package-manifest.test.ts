import { describe, expect, it } from "vitest";

import { packedPackage, packageObject, packageTargets } from "../../scripts/package-manifest.mjs";

const packed = { filename: "client.tgz", size: 128, files: [{ path: "dist/index.js" }] };

describe("npm package metadata", () => {
  it("accepts array and package-name keyed npm output", () => {
    expect(packedPackage(JSON.stringify([packed]))).toEqual(packed);
    expect(packedPackage(JSON.stringify({ "@nelcota/client": packed }))).toEqual(packed);
  });

  it.each(
    [
      [],
      [packed, packed],
      [{ ...packed, filename: 1 }],
      [{ ...packed, size: "128" }],
      [{ ...packed, files: [null] }],
      [{ ...packed, files: [{ path: 1 }] }],
    ].map((value) => ({ value })),
  )("rejects malformed pack output: %j", ({ value }) => {
    expect(() => packedPackage(JSON.stringify(value))).toThrow();
  });

  it("walks nested conditional export targets", () => {
    expect(
      packageTargets({ ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }),
    ).toEqual(["./dist/index.d.ts", "./dist/index.js"]);
    expect(() => packageTargets({ ".": 1 })).toThrow(TypeError);
  });

  it.each([null, [], "metadata"])("refuses non-object package records: %j", (value) => {
    expect(() => packageObject(value)).toThrow(TypeError);
  });
});
