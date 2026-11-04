import type { ProjectSettingKey } from "$lib/generated/contracts";

export type SettingValue = boolean | number | string[] | null;
export type ProjectSetting = {
  key: ProjectSettingKey;
  group: "authentication" | "api" | "storage";
  kind: "boolean" | "integer" | "origins";
  nullable: boolean;
  minimum: number;
  maximum: number;
  dependencies: ProjectSettingKey[];
  default_value: SettingValue;
  saved_value: SettingValue;
  expected_value: SettingValue;
  runtime_value: SettingValue;
  source: "default" | "environment";
  pending_restart: boolean | null;
};
export type ProjectSettingsView = {
  revision: string;
  settings: ProjectSetting[];
  runtime_status: "effective" | "unavailable" | "file_override" | "invalid";
  blocked: "file_override" | "invalid_saved_configuration" | null;
};
export type SettingChange = { key: ProjectSettingKey; before: SettingValue; after: SettingValue };
export type SettingsDraft = Partial<Record<ProjectSettingKey, string | boolean | null>>;
type DraftValue = SettingsDraft[ProjectSettingKey];

function matchesKind(setting: ProjectSetting, value: SettingValue): boolean {
  if (value === null) return setting.nullable;
  if (setting.kind === "boolean") return typeof value === "boolean";
  if (setting.kind === "origins") return validOrigins(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Compare bounded scalar/list values without confusing array identity with a change. */
function sameSettingValue(left: SettingValue, right: SettingValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Exact HTTP(S) origins only: CORS lists never carry credentials or signed URLs. */
export function validOrigins(value: SettingValue): value is string[] {
  const MAX_ORIGINS = 32;
  const MAX_ORIGIN_LENGTH = 2048;
  const MAX_TOTAL_ORIGIN_BYTES = 12288;
  if (
    Array.isArray(value) === false ||
    value.length > MAX_ORIGINS ||
    new Set(value).size !== value.length
  )
    return false;
  if (value.join(",").length > MAX_TOTAL_ORIGIN_BYTES) return false;
  return value.every((origin) => {
    try {
      const url = new URL(origin);
      return (
        origin.length <= MAX_ORIGIN_LENGTH &&
        ["http:", "https:"].includes(url.protocol) &&
        url.origin === origin
      );
    } catch {
      return false;
    }
  });
}

/** Cross-field checks complement the generated wire schema, never authorize writes. */
export function consistentProjectSettings(view: ProjectSettingsView): boolean {
  const keys = new Set(view.settings.map((setting) => setting.key));
  if (keys.size !== view.settings.length) return false;
  if (view.blocked !== null) return view.settings.length === 0;
  if (view.settings.length === 0) return false;
  return view.settings.every((setting) => {
    if (
      setting.minimum > setting.maximum ||
      matchesKind(setting, setting.default_value) === false ||
      matchesKind(setting, setting.saved_value) === false ||
      matchesKind(setting, setting.expected_value) === false ||
      setting.dependencies.some((key) => keys.has(key) === false)
    )
      return false;
    if (view.runtime_status !== "effective")
      return setting.pending_restart === null && setting.runtime_value === null;
    return (
      matchesKind(setting, setting.runtime_value) &&
      setting.pending_restart ===
        (sameSettingValue(setting.expected_value, setting.runtime_value) === false)
    );
  });
}

/** Initialize an in-memory draft; no credentials or changes go into browser storage. */
export function settingsDraft(view: ProjectSettingsView): SettingsDraft {
  return Object.fromEntries(
    view.settings.map((setting): [ProjectSettingKey, string | boolean | null] => {
      if (setting.nullable && setting.source === "default") return [setting.key, null];
      if (typeof setting.saved_value === "number")
        return [setting.key, String(setting.saved_value)];
      if (Array.isArray(setting.saved_value)) return [setting.key, setting.saved_value.join("\n")];
      return [setting.key, setting.saved_value];
    }),
  );
}

function integerDraft(setting: ProjectSetting, raw: DraftValue): number | undefined {
  if (typeof raw !== "string" || /^\d+$/.test(raw) === false) return undefined;
  const number = Number(raw);
  // Preserve valid legacy host values outside the panel's tighter bounds;
  // never silently clamp them or prevent an unrelated edit.
  if (number === setting.saved_value) return number;
  if (
    Number.isSafeInteger(number) === false ||
    number < setting.minimum ||
    number > setting.maximum
  )
    return undefined;
  return number;
}

function originsDraft(raw: DraftValue): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const origins = raw
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return validOrigins(origins) ? origins : undefined;
}

function parsedDraft(setting: ProjectSetting, raw: DraftValue): SettingValue | undefined {
  if (raw === null && setting.nullable) return null;
  switch (setting.kind) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "origins":
      return originsDraft(raw);
    case "integer":
      return integerDraft(setting, raw);
  }
}

/** Produce only changed, typed catalog values; null resets a nullable field to its default. */
export function projectChanges(
  view: ProjectSettingsView,
  draft: SettingsDraft,
): Partial<Record<ProjectSettingKey, SettingValue>> | null {
  if (view.blocked !== null) return null;
  const changes: Partial<Record<ProjectSettingKey, SettingValue>> = {};
  for (const setting of view.settings) {
    const value = parsedDraft(setting, draft[setting.key]);
    if (value === undefined) return null;
    const changed =
      value === null
        ? setting.source === "environment"
        : sameSettingValue(value, setting.saved_value) === false;
    if (changed) changes[setting.key] = value;
  }
  return changes;
}
