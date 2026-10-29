import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
// Serves the browser demo and built ESM modules from this checkout.
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const EXAMPLE_PORT = 5178;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
function allowedDirectory(relative: string): string | null {
  if (relative.startsWith("examples/")) return "examples";
  return relative.startsWith("dist/") ? "dist" : null;
}
const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
  try {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const relative = path === "/" ? "examples/browser.html" : path.slice(1);
    const directory = allowedDirectory(relative);
    if (directory === null) {
      response.writeHead(HTTP_NOT_FOUND).end();
      return;
    }
    const base = resolve(root, directory);
    const target = resolve(base, relative.slice(directory.length + 1));
    if (target.startsWith(base + sep) === false) {
      response.writeHead(HTTP_NOT_FOUND).end();
      return;
    }
    const body = await readFile(target);
    response
      .writeHead(HTTP_OK, { "content-type": types[extname(target)] ?? "application/octet-stream" })
      .end(body);
  } catch {
    response.writeHead(HTTP_NOT_FOUND).end();
  }
};
createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    response.destroy(
      error instanceof Error ? error : new Error("Request handler failed", { cause: error }),
    );
  });
}).listen(EXAMPLE_PORT, "127.0.0.1", () => console.log("Browser example: http://127.0.0.1:5178"));
