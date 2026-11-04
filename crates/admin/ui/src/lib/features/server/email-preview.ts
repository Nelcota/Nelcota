import type { EmailPreviewRequest, ProjectSettingKey } from "$lib/generated/contracts";

import type { ProjectSettingsView, SettingsDraft } from "./project-settings";

const EMAIL_FIELDS = {
  recovery: {
    subject: "email_recovery_subject_base64",
    text: "email_recovery_text_base64",
    ttl: "email_recovery_ttl_minutes",
  },
  signup: {
    subject: "email_signup_subject_base64",
    text: "email_signup_text_base64",
    ttl: "email_signup_ttl_minutes",
  },
  magiclink: {
    subject: "email_magiclink_subject_base64",
    text: "email_magiclink_text_base64",
    ttl: "email_magiclink_ttl_minutes",
  },
} as const;
export type EmailKind = keyof typeof EMAIL_FIELDS;

/** Preview exactly the selected draft, including reset-to-language-default fields. */
export function emailPreviewRequest({
  project,
  kind,
  view,
  draft,
}: {
  project: string;
  kind: EmailKind;
  view: ProjectSettingsView;
  draft: SettingsDraft;
}): EmailPreviewRequest | null {
  const fields = EMAIL_FIELDS[kind];
  const language = draft.email_language;
  const subject = draft[fields.subject];
  const text = draft[fields.text];
  if (language !== "en" && language !== "pt-BR") return null;
  if (nullableText(subject) === false || nullableText(text) === false) return null;
  const ttl = lifetime(view, fields.ttl, draft[fields.ttl]);
  if (ttl === null) return null;
  return { project, kind, language, subject, text, ttl_minutes: ttl };
}

function nullableText(value: SettingsDraft[ProjectSettingKey]): value is string | null {
  return value === null || typeof value === "string";
}

function lifetime(
  view: ProjectSettingsView,
  key: ProjectSettingKey,
  raw: SettingsDraft[ProjectSettingKey],
): number | null {
  const bounds = view.settings.find((setting) => setting.key === key);
  if (typeof raw !== "string" || /^\d+$/.test(raw) === false || bounds === undefined) return null;
  const ttl = Number(raw);
  if (Number.isSafeInteger(ttl) === false || ttl < bounds.minimum || ttl > bounds.maximum)
    return null;
  return ttl;
}
