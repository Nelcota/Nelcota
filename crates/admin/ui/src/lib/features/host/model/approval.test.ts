import { expect, it } from "vitest";

import { approvalReady } from "./approval";
type Readiness = Parameters<typeof approvalReady>[0];
const target = { kind: "backup", project: "shop" } as const;
const plan = {
  id: "a".repeat(64),
  operation: target,
  confirmation: "BACKUP shop",
  expires_at: 100,
  version: "0.5.6",
  image_digest: "b".repeat(64),
  blockers: [],
  ram_mb: 1024,
  free_bytes: 100000,
  project_count: 1,
  destructive: false,
};
const ready: Readiness = {
  busy: false,
  offline: false,
  target,
  password: "test-password",
  confirmation: "BACKUP shop",
  phrase: "BACKUP shop",
  acknowledged: true,
  rescue: true,
  active: false,
  recovery: null,
  pending: null,
  seconds: 30,
  plan,
};
it.each<Partial<Readiness>>([
  { busy: true },
  { offline: true },
  { target: null },
  { password: "" },
  { confirmation: "BACKUP other" },
  { acknowledged: false },
  { rescue: false },
  { active: true },
  { seconds: 0 },
  { plan: { ...plan, blockers: ["host_busy"] } },
])("host approval refuses unmet confirmation, admission or freshness (%j)", (change) => {
  expect(approvalReady({ ...ready, ...change })).toBe(false);
});
it("a confirmed live plan can submit, and a persisted retry can reconcile a busy host", () => {
  expect(approvalReady(ready)).toBe(true);
  expect(
    approvalReady({
      ...ready,
      plan: null,
      active: true,
      pending: {
        plan: "a".repeat(64),
        key: "b".repeat(64),
        operation: target,
        confirmation: ready.phrase,
      },
    }),
  ).toBe(true);
});
