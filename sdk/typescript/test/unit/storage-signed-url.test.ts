import { expect, it } from "vitest";

import { client } from "./http-client-fixtures.js";
import { empty, json, mockFetch } from "./http-fixtures.js";

it.each([null, false, 42, "not an object", [], {}, { signed_url: null }])(
  "returns invalid_response for a malformed signed URL response (%j)",
  async (body) => {
    const nelcota = client(mockFetch(json(body)));
    try {
      const result = await nelcota.storage.from("docs").createSignedUrl("a.txt", 60);
      expect(result).toMatchObject({ data: null, error: { code: "invalid_response" } });
    } finally {
      nelcota.dispose();
    }
  },
);

it.each([200, 204])(
  "returns invalid_response for an empty signed URL response (%s)",
  async (status) => {
    const nelcota = client(mockFetch(empty(status)));
    try {
      const result = await nelcota.storage.from("docs").createSignedUrl("a.txt", 60);
      expect(result).toMatchObject({ data: null, error: { code: "invalid_response" } });
    } finally {
      nelcota.dispose();
    }
  },
);
