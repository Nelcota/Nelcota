// Flags function names joined by "And" (validateAndSave): CLAUDE.md asks to split a function
// whose description needs "and", since it is doing two things. It is a warning because
// compound nouns (acceptTermsAndConditions, handleDragAndDrop) are legitimate single tasks.
import { staticKeyName } from "./property-name.js";

const JOINED_BY_AND = /[a-z0-9]And[A-Z]|_and_/;

/**
 * @param {import("estree").Node | null | undefined} node
 */
function isFunctionNode(node) {
  return (
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

/**
 * @param {import("./contracts/rules.js").RuleContext} context
 * @param {import("./contracts/rules.js").RuleNode} node
 * @param {string | undefined} name
 */
function reportIfJoined(context, node, name) {
  if (name == null || JOINED_BY_AND.test(name) === false) {
    return;
  }
  context.report({
    node,
    message: `"${name}" looks like it does two things. Split it into one function per responsibility.`,
  });
}

/**
 * @param {import("./contracts/rules.js").RuleContext} context
 * @param {import("estree").MethodDefinition | import("estree").Property | import("estree").PropertyDefinition} node
 * @param {import("estree").Node | null | undefined} value
 */
function checkKeyedFunction(context, node, value) {
  if (isFunctionNode(value)) {
    reportIfJoined(context, node.key, staticKeyName(node.key, node.computed));
  }
}

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "naming" },
  rules: {
    "no-and-in-names": {
      create(context) {
        return {
          FunctionDeclaration(node) {
            reportIfJoined(context, node.id ?? node, node.id?.name);
          },
          VariableDeclarator(node) {
            if (isFunctionNode(node.init) && node.id.type === "Identifier") {
              reportIfJoined(context, node.id, node.id.name);
            }
          },
          MethodDefinition(node) {
            checkKeyedFunction(context, node, node.value);
          },
          Property(node) {
            checkKeyedFunction(context, node, node.value);
          },
          PropertyDefinition(node) {
            checkKeyedFunction(context, node, node.value);
          },
        };
      },
    },
  },
};
