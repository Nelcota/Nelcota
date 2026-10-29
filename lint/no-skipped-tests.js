// Forbids skipping or focusing tests: a skipped test hides a failure and a focused one
// silently stops the rest of the suite from running. The jest/* rules do not recognize bun:test.
import { isMemberOf, memberPropertyName } from "./property-name.js";

const TEST_FUNCTIONS = ["test", "it", "describe"];
const SKIPPING_MODIFIERS = ["skip", "only", "todo", "skipIf", "todoIf", "if"];
const SKIPPING_ALIASES = new Set(["xtest", "xit", "xdescribe", "fit", "fdescribe"]);
const SKIP_ADVICE = "fix or delete the test instead of skipping or focusing it.";

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "tests" },
  rules: {
    "no-skipped-tests": {
      create(context) {
        return {
          MemberExpression(node) {
            if (isMemberOf(node, TEST_FUNCTIONS, SKIPPING_MODIFIERS) === true) {
              context.report({
                node,
                message: `Do not use ${node.object.name}.${memberPropertyName(node)}: ${SKIP_ADVICE}`,
              });
            }
          },
          CallExpression(node) {
            if (node.callee.type === "Identifier" && SKIPPING_ALIASES.has(node.callee.name)) {
              context.report({
                node: node.callee,
                message: `Do not use ${node.callee.name}: ${SKIP_ADVICE}`,
              });
            }
          },
        };
      },
    },
  },
};
