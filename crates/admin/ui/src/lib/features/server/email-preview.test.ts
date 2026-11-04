import { expect, it } from "vitest";

import { emailPreviewRequest } from "./email-preview";
import {
  projectChanges,
  settingsDraft,
  type ProjectSetting,
  type ProjectSettingsView,
} from "./project-settings";

const fields: ProjectSetting[] = [
  {
    key: "email_language",
    group: "email",
    kind: "text",
    nullable: false,
    minimum: 2,
    maximum: 5,
    dependencies: [],
    default_value: "en",
    saved_value: "en",
    expected_value: "en",
    runtime_value: "en",
    source: "default",
    pending_restart: false,
  },
  {
    key: "email_recovery_subject_base64",
    group: "email",
    kind: "text",
    nullable: true,
    minimum: 1,
    maximum: 200,
    dependencies: ["email_language"],
    default_value: null,
    saved_value: null,
    expected_value: "Reset your password",
    runtime_value: "Reset your password",
    source: "default",
    pending_restart: false,
  },
  {
    key: "email_recovery_text_base64",
    group: "email",
    kind: "text",
    nullable: true,
    minimum: 1,
    maximum: 2048,
    dependencies: ["email_language"],
    default_value: null,
    saved_value: null,
    expected_value: "Hello {{email}}\n{{link}}",
    runtime_value: "Hello {{email}}\n{{link}}",
    source: "default",
    pending_restart: false,
  },
  {
    key: "email_recovery_ttl_minutes",
    group: "email",
    kind: "integer",
    nullable: false,
    minimum: 5,
    maximum: 1440,
    dependencies: [],
    default_value: 60,
    saved_value: 60,
    expected_value: 60,
    runtime_value: 60,
    source: "default",
    pending_restart: false,
  },
];
function fixture(): ProjectSettingsView {
  return {
    revision: "d".repeat(64),
    settings: structuredClone(fields),
    runtime_status: "effective",
    blocked: null,
  };
}

it("previews the exact plaintext draft without treating resets as encoded strings", () => {
  const view = fixture();
  const draft = settingsDraft(view);
  expect(projectChanges(view, draft)).toEqual({});
  expect(emailPreviewRequest({ project: "shop", kind: "recovery", view, draft })).toEqual({
    project: "shop",
    kind: "recovery",
    language: "en",
    subject: null,
    text: null,
    ttl_minutes: 60,
  });
  const text = "Olá {{email}}!\nD'água $HOME \\ #\n{{link}}";
  draft.email_language = "pt-BR";
  draft.email_recovery_text_base64 = text;
  draft.email_recovery_ttl_minutes = "10";
  expect(emailPreviewRequest({ project: "shop", kind: "recovery", view, draft })?.text).toBe(text);
  expect(projectChanges(view, draft)).toEqual({
    email_language: "pt-BR",
    email_recovery_text_base64: text,
    email_recovery_ttl_minutes: 10,
  });
  expect(view.settings[0]?.saved_value).toBe("en");
});

it("rejects invalid preview languages, missing fields and noninteger/out-of-range lifetimes", () => {
  const view = fixture();
  const draft = settingsDraft(view);
  for (const invalid of ["0", "4", "1441", "1.5", "NaN", "Infinity", "9007199254740992"])
    expect(
      emailPreviewRequest({
        project: "shop",
        kind: "recovery",
        view,
        draft: {
          ...draft,
          email_recovery_ttl_minutes: invalid,
        },
      }),
    ).toBeNull();
  expect(
    emailPreviewRequest({
      project: "shop",
      kind: "recovery",
      view,
      draft: { ...draft, email_language: "other" },
    }),
  ).toBeNull();
  expect(emailPreviewRequest({ project: "shop", kind: "signup", view, draft })).toBeNull();
});

it("template changes respect UTF-8 byte bounds and never persist an empty or oversized draft", () => {
  const view = fixture();
  const draft = settingsDraft(view);
  expect(projectChanges(view, { ...draft, email_recovery_text_base64: "" })).toBeNull();
  expect(
    projectChanges(view, { ...draft, email_recovery_text_base64: "á".repeat(1025) }),
  ).toBeNull();
  expect(
    projectChanges(view, { ...draft, email_recovery_subject_base64: "á".repeat(101) }),
  ).toBeNull();
});
