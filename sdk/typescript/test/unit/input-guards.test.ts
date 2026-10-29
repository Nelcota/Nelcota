import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient, memoryStorage, NelcotaUsageError } from "../../src/index.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

function fixture(response: Response) {
  const mock = mockFetch(response);
  const storage = memoryStorage();
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    retries: 0,
    auth: { autoRefresh: false, storage, storageKey: "guards" },
  });
  return { client, storage, calls: mock.calls };
}

function sparseRows(): unknown[] {
  const rows: unknown[] = [];
  rows.length = 1;
  return rows;
}

it.each(
  [null, undefined, "", 1, [], [null], [1], [""], [[]], sparseRows()].map((value) => ({ value })),
)("rejects invalid rows before building writes (%j)", ({ value: values }) => {
  const { client, calls } = fixture(empty());
  try {
    expect(() => client.from("notes").insert(values as never)).toThrow(NelcotaUsageError);
    expect(() => client.from("notes").upsert(values as never)).toThrow(NelcotaUsageError);
    expect(calls).toHaveLength(0);
  } finally {
    client.dispose();
  }
});

it("preserves default rows, empty strings and explicit null field values", async () => {
  const { client, calls } = fixture(empty(201));
  try {
    await client
      .from("notes")
      .insert([{}, { title: "", metadata: null }])
      .execute();
    expect(
      JSON.parse(requiredValue(requiredValue(calls[0], "recorded test item").body, "request body")),
    ).toEqual([{}, { title: "", metadata: null }]);
  } finally {
    client.dispose();
  }
});

it.each(["", null, 0])("refuses an explicit invalid referenced table (%j)", (referencedTable) => {
  const { client, calls } = fixture(json([]));
  const query = client.from("notes").select();
  const options = { referencedTable } as never;
  try {
    expect(() => query.limit(1, options)).toThrow(NelcotaUsageError);
    expect(() => query.order("id", options)).toThrow(NelcotaUsageError);
    expect(() => query.or((c) => [c.eq("id", 1)], options)).toThrow(NelcotaUsageError);
    expect(calls).toHaveLength(0);
  } finally {
    client.dispose();
  }
});

it.each(["", " \n", null, undefined])(
  "rejects an empty OAuth code before claiming its verifier (%j)",
  async (code) => {
    const { client, storage, calls } = fixture(json(session()));
    try {
      await storage.setItem("guards.pkce", "v".repeat(64));
      await expect(client.auth.exchangeCode(code as never)).rejects.toThrow(NelcotaUsageError);
      expect(await storage.getItem("guards.pkce")).toBe("v".repeat(64));
      expect(calls).toHaveLength(0);
      expect((await client.auth.exchangeCode("valid-code")).error).toBeNull();
      expect(await storage.getItem("guards.pkce")).toBeNull();
    } finally {
      client.dispose();
    }
  },
);

it.each(["requestPasswordReset", "sendMagicLink", "resendConfirmation"] as const)(
  "%s returns a rejected promise for an invalid email",
  async (method) => {
    const { client, calls } = fixture(empty());
    try {
      let result: ReturnType<typeof client.auth.requestPasswordReset> | undefined;
      expect(() => {
        result = client.auth[method]("  ");
      }).not.toThrow();
      await expect(result).rejects.toThrow(NelcotaUsageError);
      expect(calls).toHaveLength(0);
    } finally {
      client.dispose();
    }
  },
);

it("does not accept a session without a user identity", async () => {
  const { client, storage } = fixture(empty());
  try {
    const value = session();
    await expect(
      client.auth.setSession({ ...value, user: { ...value.user, id: "" } }),
    ).rejects.toThrow(NelcotaUsageError);
    expect(await storage.getItem("guards")).toBeNull();
  } finally {
    client.dispose();
  }
});

it.each([null, undefined])(
  "refuses a missing upload body (%j), preserving an explicit empty file",
  async (body) => {
    const stored = {
      id: "o1",
      bucket: "docs",
      name: "empty.txt",
      size: 0,
      mime_type: "text/plain",
      etag: "e",
    };
    const { client, calls } = fixture(json(stored));
    try {
      const files = client.storage.from("docs");
      await expect(files.upload("empty.txt", body as never)).rejects.toThrow(NelcotaUsageError);
      expect(calls).toHaveLength(0);
      expect((await files.upload("empty.txt", "")).data).toEqual(stored);
      expect(calls).toHaveLength(1);
    } finally {
      client.dispose();
    }
  },
);

it.each([null, "", {}, [], { id: "" }])(
  "rejects a missing storage item representation (%j)",
  async (body) => {
    const { client } = fixture(json(body));
    try {
      for (const result of [
        await client.storage.getBucket("docs"),
        await client.storage.createBucket("docs"),
        await client.storage.updateBucket("docs", {
          public: false,
          file_size_limit: null,
          allowed_mime_types: null,
        }),
        await client.storage.from("docs").upload("a.txt", "x"),
      ]) {
        expect(result.error?.code).toBe("invalid_response");
        expect(result.data).toBeNull();
      }
    } finally {
      client.dispose();
    }
  },
);

it.each([null, {}, [null], [{}]])("rejects malformed bucket collections (%j)", async (body) => {
  const { client } = fixture(json(body));
  try {
    expect((await client.storage.listBuckets()).error?.code).toBe("invalid_response");
  } finally {
    client.dispose();
  }
});

it.each([
  null,
  {},
  { folders: null, objects: [] },
  { folders: [], objects: null },
  { folders: [null], objects: [] },
  { folders: [], objects: [null] },
  { folders: [], objects: [{}] },
])("rejects malformed file listings (%j)", async (body) => {
  const { client } = fixture(json(body));
  try {
    expect((await client.storage.from("docs").list()).error?.code).toBe("invalid_response");
  } finally {
    client.dispose();
  }
});

it("preserves empty collections and nullable bucket settings", async () => {
  const first = fixture(json([]));
  const second = fixture(json({ folders: [], objects: [] }));
  const bucket = {
    id: "docs",
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
    created_at: "",
    updated_at: "",
  };
  const third = fixture(json(bucket));
  try {
    expect((await first.client.storage.listBuckets()).data).toEqual([]);
    expect((await second.client.storage.from("docs").list()).data).toEqual({
      folders: [],
      objects: [],
    });
    expect((await third.client.storage.getBucket("docs")).data).toEqual(bucket);
  } finally {
    first.client.dispose();
    second.client.dispose();
    third.client.dispose();
  }
});

it("rejects a missing HTTP representation without retrying or throwing a raw null access", async () => {
  const mock = mockFetch(empty(200));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    const result = await client.storage.getBucket("docs");
    expect(result).toMatchObject({ data: null, error: { code: "invalid_response", status: 200 } });
    expect(mock.calls).toHaveLength(1);
  } finally {
    client.dispose();
  }
});

it("preserves null owner/metadata and an empty file in an otherwise valid listing", async () => {
  const listing = {
    folders: [],
    objects: [
      {
        id: "o1",
        name: "empty.txt",
        size: 0,
        mime_type: "text/plain",
        etag: "e",
        owner: null,
        metadata: null,
        created_at: "",
        updated_at: "",
      },
    ],
  };
  const { client } = fixture(json(listing));
  try {
    expect((await client.storage.from("docs").list()).data).toEqual(listing);
  } finally {
    client.dispose();
  }
});
