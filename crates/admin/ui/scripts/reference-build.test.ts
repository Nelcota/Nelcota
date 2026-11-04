import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { checkReferenceBundle } from "./reference-build.ts";

function chunk(
  name: string,
  options: {
    code?: string;
    imports?: string[];
    modules?: Record<string, { renderedLength: number }>;
  } = {},
) {
  return {
    type: "chunk" as const,
    name,
    isEntry: name === "reference",
    code: options.code ?? "",
    imports: options.imports ?? [],
    modules: options.modules ?? {},
  };
}

describe("reference startup budget", () => {
  it("counts shared startup chunks once, including import cycles", () => {
    const code = "export const fixture = 1;";
    expect(
      checkReferenceBundle({
        "reference.js": chunk("reference", { code, imports: ["vendor.js", "shared.js"] }),
        "vendor.js": chunk("vendor", { code, imports: ["shared.js"] }),
        "shared.js": chunk("shared", { code, imports: ["reference.js"] }),
        "lazy.js": chunk("lazy", { code }),
      }),
    ).toBe(gzipSync(code, { level: 9 }).length * 3);
  });

  it("does not let code splitting bypass the startup budget", () => {
    const code = randomBytes(2_000_000).toString("base64");
    expect(() =>
      checkReferenceBundle({
        "reference.js": chunk("reference", { imports: ["vendor.js"] }),
        "vendor.js": chunk("vendor", { code }),
      }),
    ).toThrow("budget is 1100000 B");
  });

  it("fails closed for missing entry points or startup dependencies", () => {
    expect(() => checkReferenceBundle({})).toThrow("Missing API reference entry");
    expect(() =>
      checkReferenceBundle({ "reference.js": chunk("reference", { imports: ["missing.js"] }) }),
    ).toThrow("Missing API reference startup chunk");
  });
});

describe("offline reference hosted modules", () => {
  it.each([
    "/node_modules/@ai-sdk/vue/dist/index.js",
    "D:\\Nelcota\\node_modules\\ai\\dist\\index.js",
    "/node_modules/@scalar/agent-chat/dist/index.js",
    "/node_modules/@scalar/api-reference/dist/features/explore-scalar/index.js",
    "/node_modules/@scalar/api-reference/dist/features/developer-tools/index.js",
    "/node_modules/@scalar/api-reference/dist/components/AgentScalar/AgentScalarDrawer.vue.js",
  ])("rejects hosted code even in a lazy chunk: %s", (id) => {
    expect(() =>
      checkReferenceBundle({
        "reference.js": chunk("reference"),
        "lazy.js": chunk("lazy", { modules: { [id]: { renderedLength: 1 } } }),
      }),
    ).toThrow("Hosted Scalar feature was bundled");
  });

  it("accepts tree-shaken hosted modules", () => {
    expect(
      checkReferenceBundle({
        "reference.js": chunk("reference", {
          modules: { "/node_modules/ai/dist/index.js": { renderedLength: 0 } },
        }),
      }),
    ).toBe(gzipSync("", { level: 9 }).length);
  });
});
