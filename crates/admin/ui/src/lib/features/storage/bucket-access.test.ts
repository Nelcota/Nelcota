import type { StoragePolicy } from "$lib/contracts/types";
import { describe, expect, it } from "vitest";

import { canonical, describeRule, locked } from "./bucket-access";

// Exactly as Postgres 17 prints the template policies back (pg_policies).
const policy = (patch: Partial<StoragePolicy>): StoragePolicy => ({
  name: "p",
  command: "SELECT",
  roles: ["authenticated"],
  using: null,
  check: null,
  all_buckets: false,
  ...patch,
});
const folder =
  "((bucket_id = 'docs'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))";
const owner = "((bucket_id = 'docs'::text) AND (owner = auth.uid()))";

describe("file access rules", () => {
  it("recognizes every template as Postgres prints it", () => {
    const read = { command: "SELECT", using: "(bucket_id = 'docs'::text)" };
    expect(describeRule(policy({ ...read, roles: ["anon", "authenticated"] }), "docs")).toEqual({
      kind: "public_read",
    });
    expect(describeRule(policy(read), "docs")).toEqual({ kind: "signed_in_read" });
    expect(
      describeRule(policy({ command: "INSERT", check: "(bucket_id = 'docs'::text)" }), "docs"),
    ).toEqual({ kind: "signed_in_upload" });
    expect(describeRule(policy({ command: "ALL", using: folder, check: folder }), "docs")).toEqual({
      kind: "own_folder",
    });
    expect(describeRule(policy({ command: "ALL", using: owner, check: owner }), "docs")).toEqual({
      kind: "own_files",
    });
  });

  it("also reads the text the panel sends", () => {
    const sent = "bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text";
    expect(canonical(sent)).toBe(canonical(folder));
  });

  it("anything else is a custom rule", () => {
    expect(describeRule(policy({ command: "ALL", using: folder, check: null }), "docs")).toEqual({
      kind: "custom",
    });
    expect(
      describeRule(
        policy({ using: "(bucket_id = 'docs'::text)", roles: ["service_role"] }),
        "docs",
      ),
    ).toEqual({ kind: "custom" });
    expect(
      describeRule(policy({ using: "true", all_buckets: true, roles: ["anon"] }), "docs"),
    ).toEqual({ kind: "custom" });
    // Another bucket's literal never reads as this one's.
    expect(describeRule(policy({ using: "(bucket_id = 'my-docs'::text)" }), "docs")).toEqual({
      kind: "custom",
    });
  });

  it("a private bucket without rules is locked", () => {
    expect(locked([], false)).toBe(true);
    expect(locked([], true)).toBe(false);
    expect(locked([policy({})], false)).toBe(false);
  });
});
