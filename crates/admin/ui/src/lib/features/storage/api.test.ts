import { api } from "$lib/transport/api";
import { beforeEach, expect, it, vi } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { requiredValue } from "../../contracts/required-value.js";
import { storageBrowserAdapter } from "./api";

vi.mock("$lib/transport/api", () => ({
  api: { get: vi.fn() },
  ApiError: class extends Error {},
  enc: encodeURIComponent,
  uploadFile: vi.fn(),
}));
beforeEach(() => vi.mocked(api.get).mockReset());

it("opens a bucket without downloading usage for every other bucket", async () => {
  const signal = new AbortController().signal;
  const bucket = {
    id: "docs",
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
    created_at: "2026-10-12",
    files: 1,
    bytes: 7,
  };
  vi.mocked(api.get).mockImplementation((path) => {
    return promiseResult(() => {
      if (path === "/storage")
        throw new Error("global overview must not be requested by the bucket browser");
      return {
        enabled: true,
        buckets: [bucket],
        public_url: "https://files.example.com",
        max_file_size: 1024,
      };
    });
  });
  expect(await storageBrowserAdapter.info("docs", signal)).toEqual({
    bucket,
    publicOrigin: "https://files.example.com",
    serverLimit: 1024,
  });
  const path = requiredValue(vi.mocked(api.get).mock.calls[0], "test fixture item")[0];
  expect(new URL(path, "https://panel.example.com").searchParams.get("bucket")).toBe("docs");
  expect(requiredValue(vi.mocked(api.get).mock.calls[0], "test fixture item")[1]).toEqual({
    signal,
  });
});

it("keeps disabled and missing bucket information empty", async () => {
  vi.mocked(api.get)
    .mockResolvedValueOnce({ enabled: false })
    .mockResolvedValueOnce({ enabled: true, buckets: [], max_file_size: 1024 });
  const signal = new AbortController().signal;
  expect(await storageBrowserAdapter.info("docs", signal)).toBeNull();
  expect(await storageBrowserAdapter.info("docs", signal)).toBeNull();
});
