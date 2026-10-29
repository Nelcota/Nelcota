// Forbids writing raw HTML into the DOM, the usual path for XSS. Build nodes with
// textContent and createElement, or escape with Bun.escapeHTML on the server.
import { isMemberOf, memberPropertyName } from "./property-name.js";

const HTML_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
const HTML_METHODS = new Set(["insertAdjacentHTML", "setHTMLUnsafe"]);
const SAFE_ALTERNATIVE = "Use textContent or build elements with createElement.";

/**
 * @param {import("estree").Node} node
 */
function isEmptyString(node) {
  return node.type === "Literal" && node.value === "";
}

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "html" },
  rules: {
    "no-inner-html": {
      create(context) {
        return {
          AssignmentExpression(node) {
            const name = memberPropertyName(node.left);
            if (name == null || HTML_PROPERTIES.has(name) === false) {
              return;
            }
            const advice = isEmptyString(node.right)
              ? "To clear the element, call replaceChildren()."
              : SAFE_ALTERNATIVE;
            context.report({ node: node.left, message: `Do not assign to ${name}. ${advice}` });
          },
          CallExpression(node) {
            const name = memberPropertyName(node.callee);
            const isRawHtmlCall =
              (name != null && HTML_METHODS.has(name)) ||
              isMemberOf(node.callee, ["document"], ["write", "writeln"]);
            if (isRawHtmlCall === true) {
              context.report({
                node: node.callee,
                message: `Do not call ${name}. ${SAFE_ALTERNATIVE}`,
              });
            }
          },
        };
      },
    },
  },
};
