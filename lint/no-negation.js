// Forbids the ! operator for negation (readability preference). !== is still allowed.
/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "local" },
  rules: {
    "no-negation": {
      create(context) {
        return {
          UnaryExpression(node) {
            if (node.operator === "!") {
              context.report({
                node,
                message:
                  "Do not use '!' for negation. Use an explicit comparison (=== false, == null, .length === 0) or a descriptively named function.",
              });
            }
          },
        };
      },
    },
  },
};
