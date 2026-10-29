import { describe, expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { empty, json, mockFetch } from "./http-fixtures.js";

describe("affected write counts", () => {
  it.each(["insert", "upsert", "update", "delete"] as const)(
    "exposes zero and positive counts for %s without requesting rows",
    async (method) => {
      for (const count of [0, 1, 3]) {
        const mock = mockFetch(
          empty(method === "insert" || method === "upsert" ? 201 : 204, {
            "content-range": `*/${count}`,
          }),
        );
        const client = createClient("https://api.example.com", { fetch: mock.fetch });
        try {
          const table = client.from("notes");
          const query =
            method === "delete"
              ? table.delete({ count: "exact" }).eq("id", 1)
              : table[method]({ title: "new" }, { count: "exact" });
          // oxlint-disable-next-line no-await-in-loop -- Observe the current request before advancing the shared fetch queue.
          const result = await query.execute();
          expect(result).toMatchObject({ data: null, error: null, count, range: null });
          expect(
            requiredValue(mock.calls[0], "recorded test item").headers.get("prefer"),
          ).toContain("count=exact");
          expect(
            requiredValue(mock.calls[0], "recorded test item").headers.get("prefer"),
          ).toContain("return=minimal");
        } finally {
          client.dispose();
        }
      }
    },
  );
  it("preserves count and upsert resolution when selecting the representation", async () => {
    const mock = mockFetch(json([{ id: 1 }], 201, { "content-range": "*/1" }));
    const client = createClient("https://api.example.com", { fetch: mock.fetch });
    try {
      const result = await client
        .from("notes")
        .upsert({ id: 1 }, { count: "exact", ignoreDuplicates: true })
        .select("id")
        .execute();
      expect(result.count).toBe(1);
      expect(requiredValue(mock.calls[0], "recorded test item").headers.get("prefer")).toBe(
        "count=exact,resolution=ignore-duplicates,return=representation",
      );
    } finally {
      client.dispose();
    }
  });
});
