import { createClient } from "../../src/index.js";
import { mockFetch } from "./http-fixtures.js";

function client(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  const nelcota = createClient("https://api.example.com/", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  return { nelcota, calls: mock.calls };
}

const query = (url: URL) => [...url.searchParams.entries()];
export { client, query };
