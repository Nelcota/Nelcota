import type { Overview, OverviewTable } from "$lib/contracts/types";
import { describe, expect, it } from "vitest";

import { attention, nextSteps } from "./next-steps";

const table = (
  name: string,
  state: OverviewTable["rls"]["state"],
  kind = "table",
): OverviewTable => ({
  name,
  kind,
  comment: null,
  rows: 0,
  rows_exact: true,
  rls: {
    state,
    label: "",
    enabled: state !== "danger",
    forced: false,
    policies: state === "ok" ? 1 : 0,
  },
  grants: { anon: [], authenticated: [] },
});

const overview = (tables: OverviewTable[], users = 0, signedIn = 0): Overview => ({
  schema: "public",
  counts: { tables: tables.length, users, signed_in_users: signedIn, policies: 0, functions: 0 },
  exposed_without_rls: [],
  tables,
});

const done = (data: Overview) =>
  Object.fromEntries(nextSteps(data).map((step) => [step.id, step.done]));

describe("nextSteps", () => {
  it("starts with nothing done", () => {
    expect(done(overview([]))).toEqual({
      table: false,
      protect: false,
      user: false,
      connect: false,
    });
  });

  it("protection needs every table guarded; views and API-less tables do not block it", () => {
    expect(
      done(overview([table("a", "ok"), table("b", "none"), table("v", "view", "view")])).protect,
    ).toBe(true);
    expect(done(overview([table("a", "ok"), table("b", "danger")])).protect).toBe(false);
    expect(done(overview([table("a", "warn")])).protect).toBe(false);
    expect(done(overview([table("a", "ok"), table("v", "danger", "view")])).protect).toBe(false);
  });

  it("counts users and an app sign-in", () => {
    expect(done(overview([table("a", "ok")], 3, 0))).toMatchObject({ user: true, connect: false });
    expect(done(overview([table("a", "ok")], 3, 1))).toEqual({
      table: true,
      protect: true,
      user: true,
      connect: true,
    });
  });
});

describe("attention", () => {
  it("lists unprotected and locked tables", () => {
    expect(
      attention(overview([table("a", "danger"), table("b", "warn"), table("c", "ok")])),
    ).toEqual({
      exposed: ["a"],
      locked: ["b"],
    });
  });
  it("includes owner views in exposure warnings", () => {
    expect(
      attention(overview([table("safe", "view", "view"), table("owner", "danger", "view")])),
    ).toEqual({ exposed: ["owner"], locked: [] });
  });
});
