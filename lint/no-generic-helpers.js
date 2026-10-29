// Forbids generic catch-all files and folders like utils.ts or helpers/: code belongs in the
// feature package that uses it, or in src/shared/ under a file named after its subject.
import { relative } from "node:path";

const GENERIC_NAMES = new Set(["util", "utils", "helper", "helpers"]);
const ADVICE =
  "Move the code to the feature package that uses it, or to src/shared/ in a file named after its subject (e.g. dates.ts).";

/**
 * @param {string} name
 */
function isGeneric(name) {
  return GENERIC_NAMES.has(name.toLowerCase());
}

// Only the path inside the project counts, so a checkout under ~/utils/ is not flagged.
/**
 * @param {string} filename
 * @param {string} cwd
 */
function genericPart(filename, cwd) {
  const segments = relative(cwd, filename).split(/[\\/]/);
  const fileName = segments.at(-1) ?? "";
  const folder = segments.slice(0, -1).find((segment) => isGeneric(segment));
  if (folder != null) {
    return `folder "${folder}/"`;
  }
  const isGenericFile = fileName
    .split(".")
    .slice(0, -1)
    .some((part) => isGeneric(part));
  return isGenericFile === true ? `file "${fileName}"` : undefined;
}

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "files" },
  rules: {
    "no-generic-helpers": {
      create(context) {
        return {
          Program(node) {
            const part = genericPart(String(context.filename), String(context.cwd));
            if (part == null) {
              return;
            }
            context.report({ node, message: `Do not create a generic ${part}. ${ADVICE}` });
          },
        };
      },
    },
  },
};
