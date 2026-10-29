import { once } from "node:events";
import { createServer, type Server, type IncomingMessage, type RequestListener } from "node:http";

import { afterEach, expect, it } from "vitest";

import { createClient } from "../../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error != null ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
it("drops bearer and cookie credentials on a cross-origin storage redirect", async () => {
  let received: IncomingMessage["headers"] | undefined;
  const destination = await listen((request, response) => {
    received = request.headers;
    response.end("public object");
  });
  const source = await listen((_request, response) => {
    response.writeHead(307, { location: destination + "/object" });
    response.end();
  });
  const client = createClient(source, {
    accessToken: () => "local-test-bearer",
    headers: { cookie: "fixture=private" },
    auth: { autoRefresh: false },
    retries: 0,
  });
  try {
    const opened = await client.storage.from("assets").open("file.txt");
    expect(opened.error).toBeNull();
    expect(await opened.data?.text()).toBe("public object");
    expect(received).toBeDefined();
    expect(received?.authorization).toBeUndefined();
    expect(received?.cookie).toBeUndefined();
  } finally {
    client.dispose();
  }
});
it("keeps encoded traversal-like table and function names inside their path segment", async () => {
  const paths: string[] = [];
  const source = await listen((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  const client = createClient(source, { auth: { autoRefresh: false }, retries: 0 });
  try {
    const input = "%2e%2e/%2e%2e/auth/v1/logout";
    await client.from(input).select().execute();
    await client.rpc(input);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^\/rest\/v1\/%252e%252e%2F/);
    expect(paths[1]).toMatch(/^\/rest\/v1\/rpc\/%252e%252e%2F/);
    expect(paths.every((path) => path.startsWith("/auth/") === false)).toBe(true);
  } finally {
    client.dispose();
  }
});
