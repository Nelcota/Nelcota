import { randomBytes } from "node:crypto";

import { expect, it } from "vitest";

import { Integration } from "../src/context.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";
import { origin, Jar, post } from "./storage-redirect-fixtures.js";
import { listen, redirectBackend } from "./storage-redirect-server.js";

it("follows a real loopback redirect with the runtime fetch and strips credentials on the wire", async () => {
  const seen: Record<string, string | undefined>[] = [];
  const [objects, objectOrigin] = await listen((request, response) => {
    seen.push({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      apikey: request.headers["apikey"] as string | undefined,
      range: request.headers.range,
    });
    response.end("presigned bytes");
  });
  const [backend, backendOrigin] = await listen(redirectBackend(objectOrigin, seen));

  try {
    const integration = await Integration.create({
      url: backendOrigin,
      appOrigin: origin,
      keys: [randomBytes(32).toString("base64url")],
      store: new DevelopmentSessionStore(),
      allowInsecureDevelopment: true,
      storageRedirectOrigins: [objectOrigin],
    });
    const jar = new Jar();
    await integration.write(jar, post(), (context) =>
      context.auth.signInWithPassword({ email: "one@example.test", password: "fixture-password" }),
    );
    const result = await integration.write(jar, post(), (context) =>
      context.client.storage.from("assets").download("report.pdf"),
    );
    expect(result.error).toBeNull();
    expect(await result.data?.text()).toBe("presigned bytes");
    expect(seen).toEqual([
      { authorization: "Bearer access-one" },
      { authorization: undefined, cookie: undefined, apikey: undefined, range: undefined },
    ]);
  } finally {
    objects.close();
    backend.close();
  }
});
