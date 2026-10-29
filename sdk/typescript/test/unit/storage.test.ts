import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient, NelcotaUsageError } from "../../src/index.js";
import { empty, json, mockFetch } from "./http-fixtures.js";

function client(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  return {
    nelcota: createClient("https://api.example.com", {
      fetch: mock.fetch,
      accessToken: () => "tok",
    }),
    calls: mock.calls,
  };
}

const stored = {
  id: "o1",
  bucket: "avatars",
  name: "u1/me.png",
  size: 3,
  mime_type: "image/png",
  etag: '"e"',
};

it("files: uploads raw bytes with POST, or PUT to replace", async () => {
  const { nelcota, calls } = client(json(stored, 201), json(stored, 200));
  const files = nelcota.storage.from("avatars");
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  expect((await files.upload("u1/me.png", blob)).data).toEqual(stored);
  await files.upload("u1/me.png", new Uint8Array([1]), {
    upsert: true,
    contentType: "image/png",
  });
  expect(calls.map((c) => [c.method, c.url.pathname, c.headers.get("content-type")])).toEqual([
    ["POST", "/storage/v1/object/avatars/u1/me.png", "image/png"],
    ["PUT", "/storage/v1/object/avatars/u1/me.png", "image/png"],
  ]);
  expect(requiredValue(calls[0], "recorded test item").headers.get("authorization")).toBe(
    "Bearer tok",
  );
});

it("files: defaults the content type and refuses header injection", async () => {
  const { nelcota, calls } = client(json(stored, 201));
  await nelcota.storage.from("docs").upload("a.bin", new ArrayBuffer(2));
  expect(requiredValue(calls[0], "recorded test item").headers.get("content-type")).toBe(
    "application/octet-stream",
  );
  await expect(
    nelcota.storage.from("docs").upload("a.txt", "x", { contentType: "text/plain\r\nx-evil: 1" }),
  ).rejects.toThrow(NelcotaUsageError);
});

it("files: encodes names and refuses traversal before sending", async () => {
  const { nelcota, calls } = client(empty(204));
  await nelcota.storage.from("docs").remove("reports/Q1 #2?.pdf");
  expect(requiredValue(calls[0], "recorded test item").url.pathname).toBe(
    "/storage/v1/object/docs/reports/Q1%20%232%3F.pdf",
  );
  await expect(nelcota.storage.from("docs").remove("../other/x")).rejects.toThrow(
    NelcotaUsageError,
  );
  expect(() => nelcota.storage.from("Docs")).toThrow(NelcotaUsageError);
  expect(calls).toHaveLength(1);
});

it("files: opens ranges and conditional downloads", async () => {
  const { nelcota, calls } = client(
    new Response("ab", { status: 206 }),
    new Response(null, { status: 304 }),
  );
  const files = nelcota.storage.from("docs");
  const partial = await files.open("a.txt", { range: { start: 0, end: 1 } });
  expect(partial.data?.status).toBe(206);
  expect(await partial.data?.text()).toBe("ab");
  expect(requiredValue(calls[0], "recorded test item").headers.get("range")).toBe("bytes=0-1");
  const unchanged = await files.open("a.txt", { ifNoneMatch: '"e"', download: true });
  expect(unchanged.data?.status).toBe(304);
  expect(requiredValue(calls[1], "recorded test item").headers.get("if-none-match")).toBe('"e"');
  expect(requiredValue(calls[1], "recorded test item").url.search).toBe("?download=");
  await expect(files.open("a.txt", { range: { start: 5, end: 1 } })).rejects.toThrow(
    NelcotaUsageError,
  );
});

it("files: downloads a Blob", async () => {
  const { nelcota } = client(new Response("hello", { headers: { "content-type": "text/plain" } }));
  const { data } = await nelcota.storage.from("docs").download("a.txt");
  expect(await data?.text()).toBe("hello");
});

it("files: lists a folder", async () => {
  const { nelcota, calls } = client(json({ folders: ["b"], objects: [] }));
  const { data } = await nelcota.storage.from("docs").list({ prefix: "a/", limit: 10 });
  expect(data).toEqual({ folders: ["b"], objects: [] });
  expect(requiredValue(calls[0], "recorded test item").url.pathname).toBe(
    "/storage/v1/object/list/docs",
  );
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({ prefix: "a/", limit: 10 });
});

it("files: signed URLs become absolute, public URLs need no request", async () => {
  const { nelcota, calls } = client(
    json({ signed_url: "/storage/v1/object/sign/docs/a.txt?token=t" }),
  );
  const files = nelcota.storage.from("docs");
  expect((await files.createSignedUrl("a.txt", 60)).data).toBe(
    "https://api.example.com/storage/v1/object/sign/docs/a.txt?token=t",
  );
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({ expires_in: 60 });
  await expect(files.createSignedUrl("a.txt", 0)).rejects.toThrow(NelcotaUsageError);
  expect(files.publicUrl("img/logo 1.png")).toBe(
    "https://api.example.com/storage/v1/object/public/docs/img/logo%201.png",
  );
});

it("files: refuses a signed URL pointing elsewhere", async () => {
  const { nelcota } = client(json({ signed_url: "https://evil.example.com/x" }));
  expect((await nelcota.storage.from("docs").createSignedUrl("a.txt", 60)).error?.code).toBe(
    "invalid_response",
  );
});

it.each(["9007199254740993", "9223372036854775807"])(
  "buckets: preserves int64 bucket limits on read and write (%s)",
  async (limit) => {
    const reply = () =>
      new Response(
        `{"id":"avatars","public":false,"file_size_limit":${limit},"allowed_mime_types":null,"created_at":"","updated_at":""}`,
      );
    const { nelcota, calls } = client(reply, reply, reply);
    const read = await nelcota.storage.getBucket("avatars");
    expect(read.data?.file_size_limit).toBe(limit);
    const settings = {
      public: false,
      file_size_limit: requiredValue(read.data, "response data").file_size_limit,
      allowed_mime_types: null,
    };
    expect((await nelcota.storage.updateBucket("avatars", settings)).error).toBeNull();
    expect((await nelcota.storage.createBucket("copy", settings)).error).toBeNull();
    for (const call of calls.slice(1)) {
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.body).toContain(`"file_size_limit":${limit}`);
      expect(call.body).not.toContain(`"file_size_limit":"${limit}"`);
    }
    nelcota.dispose();
  },
);

it.each([NaN, Infinity, -Infinity])(
  "buckets: refuses non-finite bucket limits before HTTP (%s)",
  async (limit) => {
    const { nelcota, calls } = client(json({}));
    try {
      await expect(
        nelcota.storage.createBucket("avatars", { file_size_limit: limit }),
      ).rejects.toThrow(NelcotaUsageError);
      await expect(
        nelcota.storage.updateBucket("avatars", {
          public: false,
          file_size_limit: limit,
          allowed_mime_types: null,
        }),
      ).rejects.toThrow(NelcotaUsageError);
      expect(calls).toHaveLength(0);
    } finally {
      nelcota.dispose();
    }
  },
);

it.each(["0", "-1", "01", "1e3", "1.5", " 1", '1,"public":true', "1e99999999999999999999"])(
  "buckets: does not turn invalid decimal settings into JSON syntax (%s)",
  async (limit) => {
    const { nelcota, calls } = client(
      json({ code: "invalid_body", message: "expected an integer" }, 422),
    );
    try {
      const result = await nelcota.storage.createBucket("avatars", {
        public: false,
        file_size_limit: limit,
      });
      expect(result.error?.status).toBe(422);
      expect(
        JSON.parse(
          requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
        ) as unknown,
      ).toEqual({
        id: "avatars",
        public: false,
        file_size_limit: limit,
      });
    } finally {
      nelcota.dispose();
    }
  },
);

it("buckets: creates, updates and deletes", async () => {
  const bucket = {
    id: "avatars",
    public: true,
    file_size_limit: null,
    allowed_mime_types: ["image/*"],
    created_at: "",
    updated_at: "",
  };
  const { nelcota, calls } = client(json(bucket, 201), json(bucket), empty(204), json([bucket]));
  await nelcota.storage.createBucket("avatars", {
    public: true,
    allowed_mime_types: ["image/*"],
  });
  await nelcota.storage.updateBucket("avatars", {
    public: true,
    file_size_limit: 1024,
    allowed_mime_types: ["image/*"],
  });
  await nelcota.storage.deleteBucket("avatars");
  expect((await nelcota.storage.listBuckets()).data).toEqual([bucket]);
  expect(
    calls.map((c) => [
      c.method,
      c.url.pathname,
      c.body == null || c.body === "" ? c.body : (JSON.parse(c.body) as unknown),
    ]),
  ).toEqual([
    [
      "POST",
      "/storage/v1/bucket",
      { id: "avatars", public: true, allowed_mime_types: ["image/*"] },
    ],
    [
      "PUT",
      "/storage/v1/bucket/avatars",
      { public: true, file_size_limit: 1024, allowed_mime_types: ["image/*"] },
    ],
    ["DELETE", "/storage/v1/bucket/avatars", null],
    ["GET", "/storage/v1/bucket", null],
  ]);
});

it("buckets: refuses incomplete replacements before sending and permits explicit clearing", async () => {
  const { nelcota, calls } = client(json({}));
  for (const settings of [
    { public: true },
    { file_size_limit: 1024, allowed_mime_types: ["image/png"] },
    { public: true, file_size_limit: 1024 },
    { public: true, allowed_mime_types: ["image/png"] },
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Observe the current request before advancing the shared storage fixture.
    await expect(nelcota.storage.updateBucket("avatars", settings as never)).rejects.toThrow(
      NelcotaUsageError,
    );
  }
  expect(calls).toHaveLength(0);
  await nelcota.storage.updateBucket("avatars", {
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
  });
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
  });
});

const protocolFixture = JSON.parse(
  readFileSync(new URL("../../../rust/tests/fixtures/protocol.json", import.meta.url), "utf8"),
) as {
  mime: { value: string; valid: boolean }[];
};
it.each(protocolFixture.mime)(
  "matches the server MIME grammar for $value",
  async ({ value, valid }) => {
    const { nelcota, calls } = client(() => json(stored));
    try {
      const before = calls.length;
      const result = nelcota.storage.from("files").upload("empty.txt", "", { contentType: value });
      if (valid === false) {
        await expect(result).rejects.toBeInstanceOf(NelcotaUsageError);
        expect(calls).toHaveLength(before);
        return;
      }
      expect((await result).error).toBeNull();
      expect(calls.at(-1)?.headers.get("content-type")).toBe(value);
    } finally {
      nelcota.dispose();
    }
  },
);
