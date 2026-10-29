import { describe, expect, it, vi } from "vitest";

import { isSession, isUser, parseSession } from "../../src/auth/session.js";
import { promiseResult } from "../../src/core/promise-result.js";
import { createClient, NelcotaUsageError } from "../../src/index.js";
import { json, mockFetch, session } from "./http-fixtures.js";

it.each([null, undefined, [], 1, "session"])(
  "session boundaries: rejects non-record input %s without throwing",
  (value) => {
    expect(isSession(value)).toBe(false);
    expect(isUser(value)).toBe(false);
  },
);

it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "session boundaries: rejects invalid session timestamps %s",
  (value) => {
    expect(isSession({ ...session(), expires_at: value })).toBe(false);
    expect(isSession({ ...session(), expires_in: value })).toBe(false);
  },
);

it("session boundaries: requires the complete session and user shape", () => {
  const value = session();
  expect(isSession(value)).toBe(true);
  expect(
    isUser({ ...value.user, email_confirmed_at: "2026-01-01", last_sign_in_at: "2026-01-01" }),
  ).toBe(true);
  expect(isSession({ ...value, token_type: null })).toBe(false);
  expect(isSession({ ...value, user: null })).toBe(false);
  expect(isSession({ ...value, expires_in: undefined })).toBe(false);
  for (const field of ["created_at", "email_confirmed_at", "last_sign_in_at"]) {
    expect(isUser({ ...value.user, [field]: undefined })).toBe(false);
  }
  expect(parseSession(null)).toBeNull();
  expect(parseSession("null")).toBeNull();
  expect(
    parseSession(JSON.stringify({ ...value, user: { ...value.user, created_at: null } })),
  ).toBeNull();
});

it("session boundaries: reports malformed server sessions without storing them", async () => {
  const mock = mockFetch(json({ ...session(), expires_in: null }));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    expect(
      (await client.auth.signInWithPassword({ email: "ana@example.com", password: "pw" })).error
        ?.code,
    ).toBe("invalid_response");
    expect((await client.auth.getSession()).data).toBeNull();
  } finally {
    client.dispose();
  }
});

it("session boundaries: rejects non-finite metadata before changing local session state", async () => {
  const client = createClient("https://api.example.com", { auth: { autoRefresh: false } });
  const value = session();
  try {
    await expect(
      client.auth.setSession({
        ...value,
        user: { ...value.user, user_metadata: { score: NaN } },
      }),
    ).rejects.toBeInstanceOf(NelcotaUsageError);
    expect((await client.auth.getSession()).data).toBeNull();
  } finally {
    client.dispose();
  }
});

it("session boundaries: preserves exact numbers in metadata loaded from storage", () => {
  const value = session();
  const text = JSON.stringify({
    ...value,
    user: { ...value.user, user_metadata: { id: "replace-me" } },
  }).replace('"replace-me"', "9007199254740993");
  expect(parseSession(text)?.user.user_metadata["id"]).toBe("9007199254740993");
});

it.each([NaN, Infinity, -Infinity, -1])(
  "session boundaries: rejects invalid refresh margins %s before scheduling",
  (refreshMargin) => {
    expect(() => createClient("https://api.example.com", { auth: { refreshMargin } })).toThrow(
      NelcotaUsageError,
    );
  },
);

it.each([0, 0.5, 60])(
  "session boundaries: accepts finite non-negative refresh margin %s",
  (refreshMargin) => {
    const client = createClient("https://api.example.com", {
      auth: { refreshMargin, autoRefresh: false },
    });
    client.dispose();
  },
);

describe("auth event delivery", () => {
  it("observes async listener failures without blocking reentrant listeners", async () => {
    const failure = new Error("listener failed");
    const onBackgroundError = vi.fn();
    const client = createClient("https://api.example.com", {
      auth: { autoRefresh: false, onBackgroundError },
    });
    let observed: string | undefined;
    client.auth.onChange(() => {
      return promiseResult(() => {
        throw failure;
      });
    });
    client.auth.onChange(async () => {
      observed = (await client.auth.getSession()).data?.user.id;
    });
    try {
      await client.auth.setSession(session());
      await vi.waitFor(() => {
        expect(onBackgroundError).toHaveBeenCalledWith(failure);
        expect(observed).toBe(session().user.id);
      });
    } finally {
      client.dispose();
    }
  });
});

it("isolates synchronous listener and error-handler failures without stopping refresh", async () => {
  vi.useFakeTimers();
  const failure = new Error("listener failed");
  const onBackgroundError = vi.fn(() => {
    return promiseResult(() => {
      throw new Error("handler failed");
    });
  });
  const mock = mockFetch(() => json(session(900, "replacement")));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: true, onBackgroundError },
  });
  const events: string[] = [];
  client.auth.onChange(() => {
    throw failure;
  });
  client.auth.onChange((event) => {
    events.push(event);
  });
  try {
    await client.auth.setSession(session());
    await vi.advanceTimersByTimeAsync(850_000);
    expect(onBackgroundError).toHaveBeenCalledWith(failure);
    expect(events).toEqual(["initial_session", "signed_in", "refreshed"]);
    expect(mock.calls).toHaveLength(1);
    expect((await client.auth.getSession()).data?.refresh_token).toBe("replacement");
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});

it("preserves synchronous listener unsubscription order", async () => {
  const client = createClient("https://api.example.com", { auth: { autoRefresh: false } });
  const later = vi.fn();
  let unsubscribe = (): void => {};
  client.auth.onChange(() => {
    unsubscribe();
  });
  unsubscribe = client.auth.onChange(later);
  try {
    await client.auth.setSession(session());
    expect(later).not.toHaveBeenCalled();
  } finally {
    client.dispose();
  }
});
