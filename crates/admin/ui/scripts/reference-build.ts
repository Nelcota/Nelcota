import { gzipSync } from "node:zlib";

import type { Plugin } from "vite";

// Count the complete static import graph, not just the entry file: removing
// lazy cloud features changes how the bundler shares and names vendor chunks.
const STARTUP_GZIP_BUDGET = 1_100_000;
const HOSTED_MODULE =
  /\/node_modules\/(?:@ai-sdk\/|ai\/|@scalar\/agent-chat\/)|\/api-reference\/dist\/(?:features\/(?:explore-scalar|developer-tools)\/|components\/AgentScalar\/)/;

interface Chunk {
  type: "chunk";
  name: string;
  isEntry: boolean;
  code: string;
  imports: string[];
  modules: Record<string, { renderedLength: number }>;
}
type Bundle = Record<string, Chunk | { type: "asset" }>;

function checkHostedModules(chunk: Chunk): void {
  for (const [id, module] of Object.entries(chunk.modules)) {
    if (module.renderedLength > 0 && HOSTED_MODULE.test(id.replaceAll("\\", "/"))) {
      throw new Error(`Hosted Scalar feature was bundled: ${id}. Review the offline patch.`);
    }
  }
}

/** Reject hosted features in any emitted chunk and bound all startup JavaScript. */
export function checkReferenceBundle(bundle: Bundle): number {
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    checkHostedModules(output);
  }

  const entry = Object.entries(bundle).find(
    ([, output]) => output.type === "chunk" && output.isEntry && output.name === "reference",
  );
  if (entry === undefined) throw new Error("Missing API reference entry in the build");

  const visited = new Set<string>();
  function startupSize(filename: string): number {
    if (visited.has(filename)) return 0;
    visited.add(filename);
    const output = bundle[filename];
    if (output?.type !== "chunk") {
      throw new Error(`Missing API reference startup chunk: ${filename}`);
    }
    return (
      gzipSync(output.code, { level: 9 }).length +
      output.imports.reduce((size, dependency) => size + startupSize(dependency), 0)
    );
  }
  const bytes = startupSize(entry[0]);
  if (bytes > STARTUP_GZIP_BUDGET) {
    throw new Error(
      `API reference startup JavaScript is ${bytes} B gzip; budget is ${STARTUP_GZIP_BUDGET} B.`,
    );
  }
  return bytes;
}

/** Keep dependency updates from restoring cloud code or growing the reference unnoticed. */
export function referenceBuild(): Plugin {
  return {
    name: "nelcota-reference-budget",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const bytes = checkReferenceBundle(bundle);
        this.info(
          `API reference startup JavaScript: ${bytes} B gzip (budget ${STARTUP_GZIP_BUDGET} B)`,
        );
      },
    },
  };
}
