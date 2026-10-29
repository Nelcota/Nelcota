import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
/** @typedef {{dist: string, examples: string, moduleFile: URL}} Paths */
const page = '<!doctype html><meta charset="utf-8"><title>sdk smoke</title><body>smoke</body>';

/** Serves only the SDK build, the runnable example and the browser contract module. @param {Paths} paths */
export function browserServer(paths) {
  return createServer((request, response) => {
    void handleRequest(request, response, paths).catch((error) =>
      response.destroy(
        error instanceof Error ? error : new Error("Request handler failed", { cause: error }),
      ),
    );
  });
}
/** @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response @param {Paths} paths */
async function handleRequest(request, response, { dist, examples, moduleFile }) {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  if (path === "/" || path === "/app") {
    response.writeHead(200, { "content-type": "text/html" }).end(page);
    return;
  }
  if (path === "/browser-contract.mjs")
    return await sendFile(response, moduleFile, "text/javascript");
  if (path === "/demo" || path === "/examples/browser.js") {
    await exampleFile(response, examples, path);
    return;
  }
  const file = normalize(join(dist, path.replace(/^\/dist\//, "/")));
  if (path.startsWith("/dist/") === false || file.startsWith(dist) === false) {
    response.writeHead(404).end();
    return;
  }
  await sendFile(response, file, distType(file));
}
function distType(/** @type {string} */ file) {
  return extname(file) === ".js" ? "text/javascript" : "application/octet-stream";
}
/** @param {import("node:http").ServerResponse} response
 * @param {string | URL} file @param {string} type */
async function sendFile(response, file, type) {
  try {
    response.writeHead(200, { "content-type": type }).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}

/** @param {import("node:http").ServerResponse} response @param {string} examples @param {string} path */
async function exampleFile(response, examples, path) {
  const file = path === "/demo" ? "browser.html" : "browser.js";
  await sendFile(
    response,
    join(examples, file),
    file.endsWith(".html") ? "text/html" : "text/javascript",
  );
}
