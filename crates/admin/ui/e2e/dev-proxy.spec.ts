import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type APIRequestContext } from "@playwright/test";
import { createServer as createViteServer, loadConfigFromFile } from "vite";

import { requiredValue } from "../src/lib/contracts/required-value.js";

function backendServer(health: () => boolean) {
  return createHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") {
      const healthy = health();
      res.writeHead(healthy ? 200 : 503);
      res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy", version: "test-backend" }));
      return;
    }
    if (req.url === "/admin/api/login" && req.method === "POST") {
      res.writeHead(req.headers.origin === `http://${req.headers.host}` ? 200 : 403);
      res.end(JSON.stringify({ accepted: res.statusCode === 200 }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
}

test("development proxy forwards backend health and preserves the login origin", async ({
  request,
}) => {
  let healthy = true;
  const backend = backendServer(() => healthy);
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as AddressInfo).port;
  const previousTarget = process.env.NELCOTA_API_URL;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    process.env.NELCOTA_API_URL = `http://127.0.0.1:${backendPort}`;
    vite = await proxyVite();
    await vite.listen();
    const vitePort = (
      requiredValue(vite.httpServer, "development HTTP server").address() as AddressInfo
    ).port;
    const base = `http://127.0.0.1:${vitePort}`;

    const health = await request.get(`${base}/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: "test-backend" });

    healthy = false;
    const unavailable = await request.get(`${base}/health`);
    expect(unavailable.status()).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unhealthy", version: "test-backend" });

    await loginOrigin(request, base);
  } finally {
    switch (previousTarget) {
      case undefined:
        delete process.env.NELCOTA_API_URL;
        break;
      default:
        process.env.NELCOTA_API_URL = previousTarget;
        break;
    }
    await vite?.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error != null ? reject(error) : resolve())),
    );
  }
});

async function proxyVite() {
  const loaded = requiredValue(
    await loadConfigFromFile({ command: "serve", mode: "development" }),
    "development Vite configuration",
  );
  const vite = await createViteServer({
    ...loaded.config,
    configFile: false,
    // This fixture requests only proxy routes; avoid a second UI warmup and dependency scan.
    // Load the real project config once, then replace its arrays instead of concatenating them.
    cacheDir: "node_modules/.vite-dev-proxy-test",
    optimizeDeps: { ...loaded.config.optimizeDeps, noDiscovery: true, entries: [], include: [] },
    server: {
      ...loaded.config.server,
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      warmup: { clientFiles: [], ssrFiles: [] },
    },
  });

  return vite;
}

async function loginOrigin(request: APIRequestContext, base: string) {
  const login = await request.post(`${base}/admin/api/login`, {
    headers: { Origin: base },
    data: {},
  });
  expect(login.status()).toBe(200);
  expect(await login.json()).toEqual({ accepted: true });

  const crossOrigin = await request.post(`${base}/admin/api/login`, {
    headers: { Origin: "http://unrelated.localhost" },
    data: {},
  });
  expect(crossOrigin.status()).toBe(403);
}
