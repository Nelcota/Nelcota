import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
/** Loads browser bundles in a realm that cannot import host modules. @param {string} bundlePath */
export function edgeLoader(bundlePath) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(bundlePath, "utf8"));
  assert(typeof parsed === "object" && parsed !== null && Array.isArray(parsed) === false);
  const sources = /** @type {Record<string, unknown>} */ (parsed);
  const context = edgeContext();
  /**
   * The inputs are the modules built from these exact sources above.
   * @typedef {{"index.js": typeof import("../src/index.js"), "seal.js": typeof import("../src/sealing/seal.js"), "memory-store.js": typeof import("../src/memory-store.js")}} Bundles
   */
  /**
   * @template {keyof Bundles} Name
   * @param {Name} name
   * @returns {Promise<Bundles[Name]>}
   */
  const load = async (name) => {
    const source = sources[name];
    assert.equal(typeof source, "string");
    if (typeof source !== "string") throw new Error("Missing built Edge module");
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => {
      throw new Error("The Edge bundle must not import Node modules");
    });
    await module.evaluate();
    return /** @type {Bundles[Name]} */ (module.namespace);
  };

  assert.equal(
    vm.runInContext('typeof Buffer + ":" + typeof process + ":" + typeof require', context),
    "undefined:undefined:undefined",
  );

  return load;
}
function edgeContext() {
  return vm.createContext({
    crypto: webcrypto,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    structuredClone,
  });
}
