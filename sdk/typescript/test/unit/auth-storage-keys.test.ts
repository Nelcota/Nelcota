import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient, memoryStorage } from "../../src/index.js";
import { session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  ["", ""],
  ["/", ""],
  ["////", ""],
  ["/api", "/api"],
  ["/api///", "/api"],
  ["/api//v1///", "/api//v1"],
  ["/api%2F///", "/api%2F"],
])(
  "session storage keys: normalizes trailing slashes in %s while retaining the base path",
  async (path, normalized) => {
    const storage = memoryStorage();
    const nelcota = createClient(`https://api.example.com${path}`, {
      auth: { storage, autoRefresh: false },
    });
    const value = session();
    try {
      await nelcota.auth.setSession(value);
      expect(
        JSON.parse(
          requiredValue(
            await storage.getItem(`nelcota.api.example.com${normalized}.session`),
            "stored session",
          ),
        ) as unknown,
      ).toEqual(value);
    } finally {
      nelcota.dispose();
    }
  },
);

it("session storage keys: handles a long slash sequence followed by a non-slash without backtracking", async () => {
  const path = `/api/${"/".repeat(100_000)}x///`;
  const storage = memoryStorage();
  const started = performance.now();
  const nelcota = createClient(`https://api.example.com${path}`, {
    auth: { storage, autoRefresh: false },
  });
  const elapsed = performance.now() - started;
  try {
    expect(elapsed).toBeLessThan(1000);
    await nelcota.auth.setSession(session());
    expect(
      await storage.getItem(`nelcota.api.example.com${path.slice(0, -3)}.session`),
    ).not.toBeNull();
  } finally {
    nelcota.dispose();
  }
});

it("session storage keys: honors a custom storage key", async () => {
  const storage = memoryStorage();
  const nelcota = createClient("https://api.example.com/api///", {
    auth: { storage, storageKey: "custom-session", autoRefresh: false },
  });
  try {
    await nelcota.auth.setSession(session());
    expect(await storage.getItem("custom-session")).not.toBeNull();
    expect(await storage.getItem("nelcota.api.example.com/api.session")).toBeNull();
  } finally {
    nelcota.dispose();
  }
});
