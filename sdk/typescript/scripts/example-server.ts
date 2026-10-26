// Serves the browser demo and built ESM modules from this checkout.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const relative = path === '/' ? 'examples/browser.html' : path.slice(1);
    const directory = relative.startsWith('examples/') ? 'examples' : relative.startsWith('dist/') ? 'dist' : null;
    if (directory === null) { response.writeHead(404).end(); return; }
    const base = resolve(root, directory);
    const target = resolve(base, relative.slice(directory.length + 1));
    if (!target.startsWith(base + sep)) {
      response.writeHead(404).end(); return;
    }
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
}).listen(5178, '127.0.0.1', () => console.log('Browser example: http://127.0.0.1:5178'));
