import { describe, expect, it } from "vitest";

import { providerName, signInMethods } from "./sign-in-methods";

describe("signInMethods", () => {
  it("lists the password first, then the linked providers", () => {
    expect(signInMethods({ has_password: true, providers: ["github", "google"] })).toEqual([
      { kind: "password" },
      { kind: "provider", name: "GitHub" },
      { kind: "provider", name: "Google" },
    ]);
    expect(signInMethods({ has_password: false, providers: ["google"] })).toEqual([
      { kind: "provider", name: "Google" },
    ]);
  });

  it("says when only email links remain", () => {
    expect(signInMethods({ has_password: false, providers: [] })).toEqual([{ kind: "linkOnly" }]);
  });

  it("names unknown providers by their id", () => {
    expect(providerName("gitlab")).toBe("Gitlab");
  });
});
