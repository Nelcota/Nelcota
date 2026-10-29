// Shared by the custom rules: resolves the name of a member or key the same way for
// element.innerHTML and element["innerHTML"], while ignoring dynamic keys like element[name].

/**
 * Returns the static name of a property key, or undefined when it is computed from a variable.
 *
 * @param {import("estree").Node | null | undefined} key - The `property` of a MemberExpression or the `key` of a property or method.
 * @param {boolean} computed - Whether the key was written in brackets.
 * @returns The property name, or undefined when it cannot be known statically.
 */
export function staticKeyName(key, computed) {
  if (key?.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  if (computed === true) {
    return undefined;
  }
  if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") {
    return key.name;
  }
  return undefined;
}

/**
 * Returns the static property name of a member expression such as `document.write` or `test["skip"]`.
 *
 * @param {import("estree").Node | null | undefined} node - Any AST node.
 * @returns The property name, or undefined when the node is not a member expression with a static name.
 */
export function memberPropertyName(node) {
  if (node?.type !== "MemberExpression") {
    return undefined;
  }
  return staticKeyName(node.property, node.computed);
}

/**
 * Tells whether a node is a member expression like `Date.parse` on a plain identifier.
 *
 * @param {import("estree").Node | null | undefined} node - Any AST node.
 * @param {readonly string[]} objectNames - Accepted names for the object, such as `["window", "globalThis"]`.
 * @param {readonly string[]} propertyNames - Accepted property names.
 * @returns {node is import("estree").MemberExpression & { object: import("estree").Identifier }} True when both the object and the property names match.
 */
export function isMemberOf(node, objectNames, propertyNames) {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    objectNames.includes(node.object.name) === true &&
    propertyNames.includes(memberPropertyName(node) ?? "") === true
  );
}
