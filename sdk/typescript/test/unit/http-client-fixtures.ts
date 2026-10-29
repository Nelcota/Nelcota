import { createClient } from "../../src/index.js";
import type { mockFetch } from "./http-fixtures.js";

function client(
  mock: ReturnType<typeof mockFetch>,
  options: Parameters<typeof createClient>[1] = {},
) {
  return createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
    ...options,
  });
}
export { client };
