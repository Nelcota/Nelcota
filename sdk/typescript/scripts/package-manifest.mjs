/** @param {unknown} value
 * @returns {Record<string, unknown>} */
export function packageObject(value) {
  if (typeof value === "object" && value !== null && Array.isArray(value) === false) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw new TypeError("Expected package metadata to be an object");
}

/** @param {unknown} value */
function packageString(value) {
  if (typeof value === "string") return value;
  throw new TypeError("Expected a package path to be a string");
}

/** Validate both npm's array output and its package-name keyed output.
 * @param {string} text */
export function packedPackage(text) {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  const results = Array.isArray(parsed) ? parsed : Object.values(packageObject(parsed));
  if (results.length !== 1) throw new Error("Expected exactly one packed package");
  const packed = packageObject(results[0]);
  const files = packed["files"];
  const size = packed["size"];
  if (Array.isArray(files) === false || typeof size !== "number") {
    throw new TypeError("Invalid packed package metadata");
  }
  return {
    filename: packageString(packed["filename"]),
    size,
    files: files.map((file) => ({ path: packageString(packageObject(file)["path"]) })),
  };
}

/** Flatten the conditional export map without assuming JSON.parse produced strings.
 * @param {unknown} exports
 * @returns {string[]} */
export function packageTargets(exports) {
  if (typeof exports === "string") return [exports];
  return Object.values(packageObject(exports)).flatMap((value) => packageTargets(value));
}
