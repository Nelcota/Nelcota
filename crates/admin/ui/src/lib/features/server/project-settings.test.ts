import { expect, it } from "vitest";

import { parsePlan } from "../host/controller";
import { parseConfiguration } from "./contracts";
import {
  consistentProjectSettings,
  projectChanges,
  settingsDraft,
  validOrigins,
  type ProjectSetting,
  type ProjectSettingsView,
} from "./project-settings";

function setting(overrides: Partial<ProjectSetting> = {}): ProjectSetting {
  return {
    key: "jwt_expiry_secs",
    group: "authentication",
    kind: "integer",
    nullable: false,
    minimum: 60,
    maximum: 86400,
    dependencies: [],
    default_value: 900,
    saved_value: 900,
    expected_value: overrides.saved_value === undefined ? 900 : overrides.saved_value,
    runtime_value: 900,
    pending_restart: false,
    source: "default",
    ...overrides,
  };
}
function view(settings: ProjectSetting[] = [setting()]): ProjectSettingsView {
  return { revision: "a".repeat(64), settings, blocked: null, runtime_status: "effective" };
}
function configuration(projectSettings: unknown) {
  return {
    project: "base",
    fields: {},
    smtp_configured: false,
    google_configured: false,
    github_configured: false,
    backup_configured: false,
    shared_login: true,
    project_settings: projectSettings,
  };
}

it("prepares only changed typed fields and keeps the source snapshot immutable", () => {
  const snapshot = view([
    setting(),
    setting({
      key: "signup_enabled",
      kind: "boolean",
      minimum: 0,
      maximum: 1,
      default_value: true,
      saved_value: true,
      runtime_value: true,
    }),
    setting({
      key: "max_rows",
      group: "api",
      nullable: true,
      minimum: 1,
      maximum: 1000000,
      default_value: 1000,
      saved_value: 1000,
      runtime_value: 1000,
    }),
  ]);
  const draft = settingsDraft(snapshot);
  expect(projectChanges(snapshot, draft)).toEqual({});
  draft.signup_enabled = false;
  draft.jwt_expiry_secs = "1200";
  expect(projectChanges(snapshot, draft)).toEqual({ signup_enabled: false, jwt_expiry_secs: 1200 });
  expect(snapshot.settings[0]?.saved_value).toBe(900);
  expect(
    projectChanges(snapshot, { ...draft, jwt_expiry_secs: "60\nNELCOTA_PRODUCTION=false" }),
  ).toBeNull();
  for (const invalid of ["", "NaN", "Infinity", "9007199254740992", "1.5", "59", "86401"])
    expect(projectChanges(snapshot, { ...draft, jwt_expiry_secs: invalid })).toBeNull();
});

it("resets nullable overrides without pretending they are zero or changing default source", () => {
  const snapshot = view([
    setting({
      key: "max_rows",
      group: "api",
      minimum: 1,
      maximum: 1000000,
      nullable: true,
      source: "environment",
      saved_value: 2000,
      runtime_value: 2000,
      default_value: 1000,
    }),
  ]);
  expect(projectChanges(snapshot, { max_rows: null })).toEqual({ max_rows: null });
  expect(projectChanges({ ...snapshot, blocked: "file_override" }, { max_rows: null })).toBeNull();
  const legacy = view([setting({ saved_value: 30, runtime_value: 30 })]);
  expect(projectChanges(legacy, settingsDraft(legacy))).toEqual({});
  expect(projectChanges(legacy, { jwt_expiry_secs: "31" })).toBeNull();
});

it("validates runtime evidence separately from saved values and rejects duplicate or inconsistent metadata", () => {
  expect(parseConfiguration(configuration(view())).project_settings?.revision).toBe("a".repeat(64));
  expect(consistentProjectSettings(view([setting(), setting()]))).toBe(false);
  for (const invalid of [
    view([setting({ minimum: 100, maximum: 60 })]),
    view([setting({ kind: "boolean" })]),
    view([setting({ pending_restart: true })]),
    view([setting({ dependencies: ["db_pool_size"] })]),
    { ...view(), runtime_status: "unavailable" },
  ])
    expect(() => parseConfiguration(configuration(invalid))).toThrow();
  const unavailable = {
    ...view([setting({ runtime_value: null, pending_restart: null })]),
    runtime_status: "unavailable",
  };
  expect(() => parseConfiguration(configuration(unavailable))).not.toThrow();
  expect(() =>
    parseConfiguration(configuration({ ...view(), blocked: "file_override", settings: [] })),
  ).not.toThrow();
});

it("generated responses reject secret/internal names, non-scalars, unsafe integers and extra properties", () => {
  for (const key of [
    "jwt_secret",
    "database_url",
    "production",
    "trust_proxy",
    "storage_backend",
  ]) {
    expect(() =>
      parseConfiguration(configuration(view([{ ...setting(), key } as ProjectSetting]))),
    ).toThrow();
  }
  for (const saved_value of ["private", { secret: true }, NaN, Infinity, -1, 9007199254740992]) {
    expect(() =>
      parseConfiguration(configuration(view([{ ...setting(), saved_value } as ProjectSetting]))),
    ).toThrow();
  }
  expect(() =>
    parseConfiguration(
      configuration(view([{ ...setting(), jwt_secret: "private" } as ProjectSetting])),
    ),
  ).toThrow();
});

it("binds public change review to a project-settings plan and admits no secret field names", () => {
  const plan = {
    affected_projects: ["base"],
    id: "a".repeat(64),
    operation: {
      kind: "configure",
      project: "base",
      section: "project_settings",
      revision: "b".repeat(64),
    },
    confirmation: "CONFIGURE base",
    expires_at: 2000,
    version: "0.5.6",
    image_digest: "c".repeat(64),
    blockers: [],
    ram_mb: 1024,
    free_bytes: 100000,
    project_count: 1,
    destructive: false,
    configuration_changes: [{ key: "signup_enabled", before: true, after: false }],
  };
  expect(parsePlan(plan).configuration_changes).toEqual(plan.configuration_changes);
  expect(() => parsePlan({ ...plan, operation: { ...plan.operation, section: "smtp" } })).toThrow();
  expect(() =>
    parsePlan({
      ...plan,
      configuration_changes: [{ key: "jwt_secret", before: null, after: true }],
    }),
  ).toThrow();
  expect(() =>
    parsePlan({
      ...plan,
      configuration_changes: [...plan.configuration_changes, ...plan.configuration_changes],
    }),
  ).toThrow();
});

it("distinguishes default, closed and restricted CORS, compares lists by value and rejects credential URLs", () => {
  const cors = setting({
    key: "cors_allow_origins",
    group: "api",
    kind: "origins",
    nullable: true,
    minimum: 0,
    maximum: 32,
    default_value: null,
    saved_value: ["https://app.test"],
    runtime_value: ["https://app.test"],
    source: "environment",
  });
  const snapshot = view([cors]);
  expect(() => parseConfiguration(configuration(snapshot))).not.toThrow();
  expect(projectChanges(snapshot, settingsDraft(snapshot))).toEqual({});
  expect(projectChanges(snapshot, { cors_allow_origins: null })).toEqual({
    cors_allow_origins: null,
  });
  expect(projectChanges(snapshot, { cors_allow_origins: "" })).toEqual({ cors_allow_origins: [] });
  expect(
    projectChanges(snapshot, { cors_allow_origins: "https://other.test\nhttp://localhost:5173" }),
  ).toEqual({ cors_allow_origins: ["https://other.test", "http://localhost:5173"] });
  for (const origin of [
    "*",
    "null",
    "https://user:private@app.test",
    "https://app.test/",
    "https://app.test?q=private",
    "https://app.test#private",
  ])
    expect(validOrigins([origin])).toBe(false);
  expect(validOrigins(["https://app.test", "https://app.test"])).toBe(false);
  expect(validOrigins([])).toBe(true);
  expect(projectChanges(snapshot, { cors_allow_origins: "https://app.test/path" })).toBeNull();
});
