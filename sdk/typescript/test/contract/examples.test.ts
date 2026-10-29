import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { runExample } from "../../examples/node.mjs";
import { createExampleServer } from "../../examples/server.mjs";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { URL_, signedIn } from "./setup.js";

it("published examples against the server: runs the Node signup, CRUD and upload/download example", async () => {
  const result = await runExample({
    url: URL_,
    email: `demo-${randomUUID()}@example.com`,
    password: "node-example-password",
    signUp: true,
  });
  expect(result.note["body"]).toBe("Hello from Node");
  expect(result.downloaded).toBe("Hello from Node");
});

it("published examples against the server: keeps concurrent server requests isolated by each caller token", async () => {
  const a = await signedIn();
  const b = await signedIn();
  await a.client.from("notes").insert({ body: "only A" }).execute();
  await b.client.from("notes").insert({ body: "only B" }).execute();
  const tokenA = requiredValue(
    (await a.client.auth.getSession()).data,
    "response data",
  ).access_token;
  const tokenB = requiredValue(
    (await b.client.auth.getSession()).data,
    "response data",
  ).access_token;
  const server = createExampleServer(URL_);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server port");
  const url = `http://127.0.0.1:${address.port}/notes`;
  try {
    const responses = await Promise.all(
      [tokenA, tokenB, tokenA, tokenB].map(async (token) => {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        const value: unknown = await response.json();
        if (Array.isArray(value) === false) throw new TypeError("Expected note rows");
        return noteBodies(value);
      }),
    );
    expect(responses).toEqual([["only A"], ["only B"], ["only A"], ["only B"]]);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const visitor = await createClient(URL_).from("notes").select().execute();
    expect(visitor.data).toBeNull();
    expect(visitor.error?.status).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => (error != null ? reject(error) : resolve())),
    );
    a.client.dispose();
    b.client.dispose();
  }
});

function noteBodies(value: unknown[]) {
  return value.map((row: unknown) => {
    if (
      row === null ||
      typeof row !== "object" ||
      "body" in row === false ||
      typeof row.body !== "string"
    )
      throw new TypeError("Expected a note body");
    return row.body;
  });
}
