import { randomBytes } from "node:crypto";

import { expect, it } from "vitest";

import { Integration } from "../src/context.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { requiredValue } from "../src/required-value.js";
import { api, post, setup, object, presigned } from "./storage-redirect-fixtures.js";

it("storage redirects: follows an allow-listed presigned redirect without credentials", async () => {
  const { integration, jar, sent } = await setup(
    { [object]: presigned },
    { storageRedirectOrigins: ["https://s3.example.test"] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf", { range: { start: 0, end: 9 } }),
  );
  expect(result.error).toBeNull();
  expect(await result.data?.text()).toBe("object from https://s3.example.test");
  expect(sent.map((request) => [request.url.href, request.redirect])).toEqual([
    [object, "manual"],
    [presigned, "manual"],
  ]);
  expect(requiredValue(sent[0], "required operation value").headers.get("authorization")).toBe(
    "Bearer access-one",
  );
  const hop = requiredValue(sent[1], "required operation value").headers;
  expect(hop.get("authorization")).toBeNull();
  expect(hop.get("cookie")).toBeNull();
  expect(hop.get("apikey")).toBeNull();
  expect(hop.get("range")).toBe("bytes=0-9");
  for (const [name] of hop)
    expect([
      "accept",
      "range",
      "if-none-match",
      "if-match",
      "if-modified-since",
      "if-unmodified-since",
      "if-range",
    ]).toContain(name);
});

it("storage redirects: keeps credentials stripped when a later hop returns to the API origin", async () => {
  const back = `${api}/storage/v1/object/assets/again`;
  const { integration, jar, sent } = await setup(
    { [object]: presigned, [presigned]: back },
    { storageRedirectOrigins: ["https://s3.example.test", api] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").download("report.pdf"),
  );
  expect(result.error).toBeNull();
  expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer access-one",
    null,
    null,
  ]);
});

it("storage redirects: refuses a destination outside the allow-list before contacting it", async () => {
  const { integration, jar, sent } = await setup(
    { [object]: "https://attacker.example.test/collect" },
    { storageRedirectOrigins: ["https://s3.example.test"] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf"),
  );
  expect(result.error?.code).toBe("storage_redirect_refused");
  expect(sent).toHaveLength(1);
});

it("storage redirects: refuses plain HTTP to a non-loopback host, by redirect and by configuration", async () => {
  const { integration, jar, sent } = await setup(
    { [object]: "http://s3.example.test/bucket/report.pdf" },
    { storageRedirectOrigins: ["https://s3.example.test"] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf"),
  );
  expect(result.error?.code).toBe("storage_redirect_refused");
  expect(sent).toHaveLength(1);
  await expect(
    setup({}, { storageRedirectOrigins: ["http://s3.example.test"] }),
  ).rejects.toMatchObject({ code: "configuration" });
  const keys = [randomBytes(32).toString("base64url")];
  const production = {
    url: "https://api.example.test",
    appOrigin: "https://app.example.test",
    keys,
    store: {
      durability: "shared" as const,
      read: () => promiseResult(() => null),
      exclusive: () => {
        return promiseResult(() => {
          throw new Error("unused");
        });
      },
    },
  };
  await expect(
    Integration.create({ ...production, storageRedirectOrigins: ["http://127.0.0.1:9000"] }),
  ).rejects.toMatchObject({ code: "configuration" });
  for (const value of [
    "https://s3.example.test/bucket",
    "https://user:pass@s3.example.test",
    "https://s3.example.test?x=1",
    "not a url",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Run redirect cases serially against the shared transport fixture.
    await expect(
      Integration.create({ ...production, storageRedirectOrigins: [value] }),
    ).rejects.toMatchObject({ code: "configuration" });
  }
  await expect(
    Integration.create({ ...production, storageRedirectOrigins: ["https://s3.example.test"] }),
  ).resolves.toBeDefined();
});

it("storage redirects: allows loopback HTTP destinations only in insecure development", async () => {
  const local = "http://127.0.0.1:9000/bucket/report.pdf";
  const { integration, jar, sent } = await setup(
    { [object]: local },
    { storageRedirectOrigins: ["http://127.0.0.1:9000"] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf"),
  );
  expect(result.error).toBeNull();
  expect(sent.at(-1)?.headers.get("authorization")).toBeNull();
});

it("storage redirects: enforces the hop limit", async () => {
  const hop = (n: number) => `https://s3.example.test/hop/${n}`;
  const { integration, jar, sent } = await setup(
    { [object]: hop(1), [hop(1)]: hop(2), [hop(2)]: hop(3), [hop(3)]: hop(4) },
    { storageRedirectOrigins: ["https://s3.example.test"] },
  );
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf"),
  );
  expect(result.error?.code).toBe("storage_redirect_limit");
  expect(sent.map((request) => request.url.href)).toEqual([object, hop(1), hop(2), hop(3)]);
});

it("storage redirects: refuses storage redirects with a clear code when no policy is configured", async () => {
  const { integration, jar, sent } = await setup({ [object]: presigned });
  const result = await integration.write(jar, post(), (context) =>
    context.client.storage.from("assets").open("report.pdf"),
  );
  expect(result.error?.code).toBe("storage_redirect_refused");
  expect(sent).toHaveLength(1);
});

it("storage redirects: never follows redirects for non-storage, listing or auth requests", async () => {
  const { integration, jar, sent } = await setup(
    {},
    { storageRedirectOrigins: ["https://s3.example.test"] },
  );
  await integration.write(jar, post(), async (context) => {
    await context.client.from("notes").select().execute();
    await context.client.rpc("mutate");
    await context.client.storage.from("assets").list();
    await context.auth.getUser();
  });
  await integration.read(jar, async (context) => {
    await context.client.from("notes").select().execute();
  });
  expect(sent.length).toBeGreaterThanOrEqual(5);
  for (const request of sent) expect(request.redirect).toBe("error");
});
