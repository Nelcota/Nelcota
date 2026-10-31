import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { json, mockFetch } from "./http-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["single", "maybeSingle"] as const)(
  "aligns %s query string/status (#141)",
  async (mode) => {
    const mock = mockFetch(json([{ id: 1 }, { id: 2 }]));
    const client = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: false },
    });
    try {
      const query = client.from("notes").select()[mode]();
      expect(new URLSearchParams(query.toString()).get("limit")).toBe("2");
      const result = await query.execute();
      // The cardinality check is the client's: the result keeps the real HTTP status.
      expect(result.status).toBe(200);
      expect(result.error?.code).toBe("not_single");
      expect(result.error?.status).toBe(0);
    } finally {
      client.dispose();
    }
  },
);
it.each(["limit", "offset", "order", "select", "or", "and", "columns", "on_conflict"])(
  "preserves reserved column %s (#139)",
  async (column) => {
    const mock = mockFetch(json([]));
    const client = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: false },
    });
    try {
      await client.from("notes").select().eq(column, 5).limit(10).execute();
      const params = requiredValue(mock.calls[0], "recorded test item").url.searchParams;
      expect(params.getAll("and")).toContain(`(${column}.eq."5")`);
      expect(params.get("limit")).toBe("10");
    } finally {
      client.dispose();
    }
  },
);
it("encodes embedded reserved filters in a logic group (#139)", async () => {
  const mock = mockFetch(json([]));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await client.from("notes").select("id,items(limit)").eq("items.limit", 5).execute();
    expect(
      requiredValue(mock.calls[0], "recorded test item").url.searchParams.get("items.and"),
    ).toBe('(limit.eq."5")');
  } finally {
    client.dispose();
  }
});
