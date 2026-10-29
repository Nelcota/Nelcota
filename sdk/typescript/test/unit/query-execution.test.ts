import { expect, it } from "vitest";

import { createClient } from "../../src/index.js";
import { json, mockFetch } from "./http-fixtures.js";

it("keeps query construction inert until execute is called", async () => {
  const { fetch, calls } = mockFetch(json([{ id: 1 }]));
  const client = createClient("https://api.example.test", { fetch, auth: { autoRefresh: false } });
  const query = client.from("notes").select("id");

  expect("then" in query).toBe(false);
  expect(await Promise.resolve(query)).toBe(query);
  expect(calls).toHaveLength(0);

  const result = await query.execute();

  expect(result.error).toBeNull();
  expect(result.data).toEqual([{ id: 1 }]);
  expect(calls).toHaveLength(1);
});
