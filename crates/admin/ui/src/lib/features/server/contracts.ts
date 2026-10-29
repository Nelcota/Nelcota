import * as contracts from "$lib/generated/validators.js";

import { ControllerError } from "../updates/controller";
import type { AlertSettings } from "./alerts-contracts";
const HTTP_BAD_GATEWAY = 502;

const sections = [
  "alerts",
  "smtp",
  "oauth_google",
  "oauth_github",
  "backup",
  "schedule",
  "admin_password",
] as const;
export type Section = (typeof sections)[number];
export type Configuration =
  | {
      section: "alerts";
      settings: AlertSettings;
      webhook_url: string | null;
      heartbeat_url: string | null;
    }
  | {
      section: "smtp";
      enabled: boolean;
      url: string | null;
      from: string;
      recovery_url: string;
      confirmation_url: string;
      magic_link_url: string;
    }
  | {
      section: "oauth_google" | "oauth_github";
      enabled: boolean;
      client_id: string;
      client_secret: string | null;
      redirects: string[];
    }
  | {
      section: "backup";
      enabled: boolean;
      endpoint: string;
      bucket: string;
      region: string;
      access_key: string | null;
      secret_key: string | null;
    }
  | { section: "schedule"; hour: number; minute: number; keep: number }
  | { section: "admin_password"; new_password: string };
export type ConfigurationView = {
  project: string;
  fields: Record<string, string>;
  smtp_configured: boolean;
  google_configured: boolean;
  github_configured: boolean;
  backup_configured: boolean;
  shared_login: boolean;
};
type CheckStatus = "passed" | "warning" | "failed" | "unavailable";
export type Diagnostics = {
  project: string;
  checked_at: number;
  memory_total_bytes: number | null;
  memory_available_bytes: number | null;
  cpu_percent: number | null;
  load_one: number | null;
  free_bytes: number;
  last_backup_at: number | null;
  last_offsite_backup_at: number | null;
  checks: { name: string; status: CheckStatus }[];
};
function invalid(): never {
  throw new ControllerError(HTTP_BAD_GATEWAY, "invalid_response");
}
export function parseConfiguration(v: unknown): ConfigurationView {
  if (contracts.HostConfigurationView(v) === false) return invalid();
  return v as ConfigurationView;
}
// The wire shapes come from the Rust contracts (D83); these rules span several values.
export function parseDiagnostics(v: unknown): Diagnostics {
  if (contracts.HostDiagnostics(v) === false) return invalid();
  const diagnostics = v as Diagnostics;
  const { memory_total_bytes: total, memory_available_bytes: available } = diagnostics;
  if (total !== null && available !== null && available > total) return invalid();
  if (new Set(diagnostics.checks.map((c) => c.name)).size !== diagnostics.checks.length)
    return invalid();
  return diagnostics;
}
export function integer(value: string, min: number, max: number): number | null {
  if (/^\d+$/.test(value) === false) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
