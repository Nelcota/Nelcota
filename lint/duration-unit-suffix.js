// Requires timer delays to come from a name that states the unit (timeoutInMs, RETRY_DELAY_IN_MS),
// so a bare 5000 or a vague "timeout" never hides whether the value is in seconds or milliseconds.
import { isMemberOf, memberPropertyName } from "./property-name.js";

const MILLISECOND_SUFFIX = /(InMs|Ms|_IN_MS|_MS)$/;
const TIMER_FUNCTIONS = ["setTimeout", "setInterval"];
const GLOBAL_OBJECTS = ["window", "globalThis", "self"];

/**
 * @param {import("estree").Node} callee
 */
function isTimerCall(callee) {
  if (callee.type === "Identifier") {
    return TIMER_FUNCTIONS.includes(callee.name);
  }
  return isMemberOf(callee, GLOBAL_OBJECTS, TIMER_FUNCTIONS);
}

/**
 * @param {import("estree").CallExpression} node
 */
function delayArgument(node) {
  if (isTimerCall(node.callee) === true) {
    return node.arguments[1];
  }
  const takesDelayFirst =
    isMemberOf(node.callee, ["AbortSignal"], ["timeout"]) === true ||
    isMemberOf(node.callee, ["Bun"], ["sleep"]) === true;
  return takesDelayFirst ? node.arguments[0] : undefined;
}

/**
 * @param {import("estree").Node} argument
 */
function delayName(argument) {
  if (argument.type === "Identifier") {
    return argument.name;
  }
  return memberPropertyName(argument);
}

/**
 * @param {import("estree").Node} argument
 */
function problemWith(argument) {
  if (argument.type === "Literal" && typeof argument.value === "number") {
    return argument.value === 0 ? undefined : `the number ${argument.value}`;
  }
  const name = delayName(argument);
  if (name == null || MILLISECOND_SUFFIX.test(name)) {
    return undefined;
  }
  return `"${name}"`;
}

/** @satisfies {import("./contracts/rules.js").RulePlugin} */
export default {
  meta: { name: "durations" },
  rules: {
    "duration-unit-suffix": {
      create(context) {
        return {
          CallExpression(node) {
            const argument = delayArgument(node);
            if (argument == null) {
              return;
            }
            const problem = problemWith(argument);
            if (problem == null) {
              return;
            }
            context.report({
              node: argument,
              message: `Timer delay ${problem} does not state its unit. Use a name ending in InMs (e.g. const timeoutInMs = 5_000).`,
            });
          },
        };
      },
    },
  },
};
