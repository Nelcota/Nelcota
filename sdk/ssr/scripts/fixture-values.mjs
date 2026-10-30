/**
 * Accept only the object shape shared by JSON fixture responses.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function fixtureObject(value) {
  if (typeof value === "object" && value !== null && Array.isArray(value) === false) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw new TypeError("Expected a fixture JSON object");
}

/** @param {unknown} value
 * @returns {string} */
export function fixtureString(value) {
  if (typeof value === "string") return value;
  throw new TypeError("Expected a fixture string");
}

/** @param {unknown} value
 * @returns {unknown[]} */
export function fixtureArray(value) {
  if (Array.isArray(value)) return value;
  throw new TypeError("Expected a fixture array");
}

/** @param {string} name */
export function fixtureEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Set ${name}`);
  return value;
}

/** @param {import("node:net").Server} server */
export function fixturePort(server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fixture has no TCP listener");
  }
  return address.port;
}

/** @param {unknown} error */
export function fixtureErrorCode(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
