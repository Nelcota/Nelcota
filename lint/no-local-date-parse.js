// Forbids parsing date strings that are not ISO 8601 with an explicit offset, since
// formats like "24/10/2026" or "2026-10-24 14:30" depend on the runtime's locale and time zone.
import { isMemberOf } from "./property-name.js";

const ISO_8601_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {import("estree").NewExpression} node
 */
function isDateConstructor(node) {
  return node.callee.type === "Identifier" && node.callee.name === "Date";
}

/**
 * @param {import("estree").Node | null | undefined} node
 */
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * @param {import("./contracts/rules.js").RuleContext} context
 * @param {import("estree").CallExpression | import("estree").NewExpression} node
 */
function checkDateArgument(context, node) {
  const argument = node.arguments[0];
  const value = staticString(argument);
  if (value == null || ISO_8601_WITH_OFFSET.test(value)) {
    return;
  }
  context.report({
    node,
    message: `Do not parse "${value}" as a date. Use ISO 8601 in UTC with an explicit offset (e.g. "2026-10-24T14:30:00Z").`,
  });
}

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "dates" },
  rules: {
    "no-local-date-parse": {
      create(context) {
        return {
          NewExpression(node) {
            if (isDateConstructor(node)) {
              checkDateArgument(context, node);
            }
          },
          CallExpression(node) {
            if (isMemberOf(node.callee, ["Date"], ["parse"]) === true) {
              checkDateArgument(context, node);
            }
          },
        };
      },
    },
  },
};
