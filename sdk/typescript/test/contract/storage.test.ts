import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { NelcotaUsageError } from "../../src/index.js";
import { serviceClient, signedIn, visitor } from "./setup.js";

it.each(["9007199254740993", "9223372036854775807"])(
  "storage against the server: round-trips exact bucket limits through the server (%s)",
  async (limit) => {
    const admin = serviceClient();
    const id = `exact-${limit}`;
    try {
      const created = await admin.storage.createBucket(id, {
        public: false,
        file_size_limit: limit,
      });
      expect(created.error).toBeNull();
      expect(created.data?.file_size_limit).toBe(limit);
      const read = await admin.storage.getBucket(id);
      expect(read.error).toBeNull();
      const updated = await admin.storage.updateBucket(id, {
        ...requiredValue(read.data, "response data"),
        public: true,
      });
      expect(updated.error).toBeNull();
      expect(updated.data).toMatchObject({ public: true, file_size_limit: limit });
      expect(
        (await admin.storage.listBuckets()).data?.find((bucket) => bucket.id === id)
          ?.file_size_limit,
      ).toBe(limit);
    } finally {
      expect((await admin.storage.deleteBucket(id)).error).toBeNull();
      admin.dispose();
    }
  },
);

it("storage against the server: keeps invalid integer settings rejected without changing bucket state", async () => {
  const admin = serviceClient();
  const id = "invalid-limit-review";
  try {
    expect(
      (await admin.storage.createBucket(id, { public: false, file_size_limit: 1024 })).error,
    ).toBeNull();
    for (const limit of [
      0,
      -1,
      1.5,
      "0",
      "-1",
      "01",
      "1e3",
      "1.5",
      " 1",
      '1,"public":true',
      "9223372036854775808",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Inspect each bucket mutation before applying the next case to the same fixture.
      const result = await admin.storage.updateBucket(id, {
        public: true,
        file_size_limit: limit,
        allowed_mime_types: null,
      });
      expect(result.error?.status).toBeGreaterThanOrEqual(400);
      // oxlint-disable-next-line no-await-in-loop -- Inspect each bucket mutation before applying the next case to the same fixture.
      const current = await admin.storage.getBucket(id);
      expect(current.data).toMatchObject({ public: false, file_size_limit: 1024 });
    }
  } finally {
    expect((await admin.storage.deleteBucket(id)).error).toBeNull();
    admin.dispose();
  }
});

it("storage against the server: uploads, downloads, ranges, ETags, lists, replaces and removes", async () => {
  const { client, id } = await signedIn();
  const files = client.storage.from("private-files");
  const name = `${id}/notes/hello world.txt`;

  const uploaded = await files.upload(name, new Blob(["hello, nelcota"], { type: "text/plain" }));
  expect(uploaded.error).toBeNull();
  expect(uploaded.data).toMatchObject({ bucket: "private-files", name, size: 14 });
  expect((await files.upload(name, "again")).error?.code).toBe("object_exists");

  expect(await (await files.download(name)).data?.text()).toBe("hello, nelcota");
  const part = await files.open(name, { range: { start: 7, end: 13 } });
  expect(part.data?.status).toBe(206);
  expect(await part.data?.text()).toBe("nelcota");
  const etag = requiredValue(
    requiredValue((await files.open(name)).data, "response data").headers.get("etag"),
    "response data",
  );
  expect((await files.open(name, { ifNoneMatch: etag })).data?.status).toBe(304);

  const listing = await files.list({ prefix: `${id}/` });
  expect(listing.data?.folders).toEqual(["notes"]);
  expect((await files.list({ prefix: `${id}/notes/` })).data?.objects.map((o) => o.name)).toEqual([
    name,
  ]);

  const replaced = await files.upload(name, "replaced", { upsert: true });
  expect(replaced.error).toBeNull();
  expect(await (await files.download(name)).data?.text()).toBe("replaced");

  expect((await files.remove(name)).error).toBeNull();
  expect((await files.download(name)).error?.status).toBe(404);
});

it("storage against the server: streams an upload without buffering it in the client", async () => {
  const { client, id } = await signedIn();
  const chunks = ["a".repeat(1000), "b".repeat(1000), "c"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const files = client.storage.from("private-files");
  const { data, error } = await files.upload(`${id}/stream.txt`, stream, {
    contentType: "text/plain",
  });
  expect(error).toBeNull();
  expect(data?.size).toBe(2001);
});

it("storage against the server: policies keep users out of each other's folders", async () => {
  const ana = await signedIn();
  const bruno = await signedIn();
  const name = `${ana.id}/secret.txt`;
  await ana.client.storage.from("private-files").upload(name, "secret");
  const intrusion = await bruno.client.storage.from("private-files").upload(`${ana.id}/x.txt`, "x");
  expect(intrusion.error?.status).toBeGreaterThanOrEqual(400);
  expect((await bruno.client.storage.from("private-files").download(name)).error?.status).toBe(404);
  expect((await visitor().storage.from("private-files").download(name)).error).not.toBeNull();
});

it("storage against the server: signed URLs work without a session; public URLs for public buckets", async () => {
  const { client, id } = await signedIn();
  const privateFiles = client.storage.from("private-files");
  await privateFiles.upload(`${id}/shared.txt`, "shared text");
  const signed = await privateFiles.createSignedUrl(`${id}/shared.txt`, 60);
  expect(signed.error).toBeNull();
  expect(await (await fetch(requiredValue(signed.data, "response data"))).text()).toBe(
    "shared text",
  );

  const publicFiles = client.storage.from("public-files");
  await publicFiles.upload(`${id}/logo 1.txt`, "public text");
  expect(await (await fetch(publicFiles.publicUrl(`${id}/logo 1.txt`))).text()).toBe("public text");
});

it("storage against the server: refuses traversal before any request", async () => {
  const { client } = await signedIn();
  await expect(client.storage.from("private-files").download("../etc/passwd")).rejects.toThrow(
    NelcotaUsageError,
  );
});

it("storage against the server: manages buckets with service_role", async () => {
  const admin = serviceClient();
  const id = `sdk-${Date.now()}`;
  const created = await admin.storage.createBucket(id, {
    public: false,
    file_size_limit: 1024,
    allowed_mime_types: ["text/plain"],
  });
  expect(created.error).toBeNull();
  expect(created.data).toMatchObject({ id, public: false, allowed_mime_types: ["text/plain"] });
  await expect(admin.storage.updateBucket(id, { public: true } as never)).rejects.toThrow(
    NelcotaUsageError,
  );
  expect((await admin.storage.getBucket(id)).data).toMatchObject({
    public: false,
    file_size_limit: 1024,
    allowed_mime_types: ["text/plain"],
  });
  const updated = await admin.storage.updateBucket(id, {
    public: true,
    file_size_limit: 1024,
    allowed_mime_types: ["text/plain"],
  });
  expect(updated.error).toBeNull();
  expect((await admin.storage.getBucket(id)).data).toMatchObject({
    public: true,
    file_size_limit: 1024,
    allowed_mime_types: ["text/plain"],
  });
  expect((await admin.storage.listBuckets()).data?.some((b) => b.id === id)).toBe(true);
  expect((await admin.storage.deleteBucket(id)).error).toBeNull();
  expect((await visitor().storage.createBucket(`${id}-x`)).error?.status).toBeGreaterThanOrEqual(
    400,
  );
});
