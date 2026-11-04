import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/operations/project-settings";

const en: Messages<typeof ptBR> = {
  authority:
    "Project settings are applied by the authenticated host operator. A project administrator login does not grant this authority.",
  impact:
    "All changes in this batch are applied together with one restart of the selected application. Project-panel sessions are lost; PostgreSQL and other projects keep running. Failure attempts to restore configuration only, never data.",
  unsupported:
    "This controller does not offer the settings catalog yet. Use a compatible controller; no fields will be applied through a fallback path.",
  notPrepared:
    "The plan was not prepared. Check the operation message and reload if configuration changed.",
  automatic: "Default / automatic",
  noOrigins: "No external origins",
  anyOrigin: "Any origin",
  yes: "Yes",
  no: "No",
  saved: "Saved",
  proposed: "Proposed",
  source: "Saved value source",
  default: "Default",
  runtimeValue: "In use by the process",
  useDefault: "Use default behavior",
  pending:
    "The saved value differs from the running process. Review the change or recover the pending operation before continuing.",
  changed: "Changed fields",
  review: "Validate batch and review impact",
  reviewedChanges: "Server-validated changes",
  groups: {
    authentication: "Authentication and sessions",
    email: "Transactional emails and links",
    api: "API and performance",
    storage: "Global file limits",
  },
  sources: { default: "Server default", environment: "Project environment file" },
  runtime: {
    effective:
      "Active values come from a safe process projection captured at startup, queried over a local connection only. The application is checked again after applying or rolling back a batch.",
    unavailable:
      "The application could not be queried or does not offer this protocol. Use compatible server and controller versions. Saved values will not be presented as active and editing is blocked.",
    file_override:
      "The container uses an additional configuration file. Active values cannot be confirmed through this workflow.",
    invalid: "The container environment could not be interpreted. No active value was assumed.",
  },
  blocked: {
    file_override:
      "This project uses NELCOTA_CONFIG. The operator must review file-based configuration before enabling changes through this workflow.",
    invalid_saved_configuration:
      "Saved configuration is invalid or uses ambiguous syntax. The operator must correct it through the recovery procedure; it will not be overwritten.",
  },
  fields: {
    email_language: {
      label: "Email language",
      hint: "English or Portuguese defaults. Custom templates are preserved; review them when changing language.",
    },
    email_recovery_subject_base64: {
      label: "Recovery subject",
      hint: "One line, up to 200 UTF-8 bytes. Variables: {{project_name}} and {{validity}}; never tokens or recipients in the subject.",
    },
    email_recovery_text_base64: {
      label: "Recovery message",
      hint: "Plain text up to 2,048 UTF-8 bytes and exactly one {{link}}. Line breaks are preserved without shell interpretation.",
    },
    email_signup_subject_base64: {
      label: "Confirmation subject",
      hint: "One line, up to 200 UTF-8 bytes. Default behavior follows the selected language.",
    },
    email_signup_text_base64: {
      label: "Confirmation message",
      hint: "Plain text up to 2,048 UTF-8 bytes and exactly one {{link}}. No executable HTML or unknown variables.",
    },
    email_magiclink_subject_base64: {
      label: "Sign-in link subject",
      hint: "One line, up to 200 UTF-8 bytes. Default behavior follows the selected language.",
    },
    email_magiclink_text_base64: {
      label: "Sign-in link message",
      hint: "Plain text up to 2,048 UTF-8 bytes and exactly one {{link}}. Links remain single-use.",
    },
    email_recovery_ttl_minutes: {
      label: "Recovery lifetime (minutes)",
      hint: "5–1,440 minutes. Applies only to new links; already issued links are unchanged.",
    },
    email_signup_ttl_minutes: {
      label: "Confirmation lifetime (minutes)",
      hint: "5–10,080 minutes. Applies only to new links; does not disable email confirmation.",
    },
    email_magiclink_ttl_minutes: {
      label: "Sign-in link lifetime (minutes)",
      hint: "1–60 minutes. This link authenticates by itself; keep its lifetime short.",
    },
    signup_enabled: {
      label: "Public signup",
      hint: "Allows new accounts. Disabling does not block existing accounts.",
    },
    jwt_expiry_secs: {
      label: "Access token lifetime (seconds)",
      hint: "Applies to newly issued tokens. Does not revoke existing tokens.",
    },
    refresh_token_ttl_days: {
      label: "Refresh token lifetime (days)",
      hint: "Applies to issuance and the next refresh-token rotation.",
    },
    auth_rate_limit_per_minute: {
      label: "Authentication requests per minute",
      hint: "Per-IP limit for login and signup. Proxy trust remains controlled by the host.",
    },
    api_rate_limit_per_minute: {
      label: "API requests per minute",
      hint: "Per-user or client-IP limit for REST and files. Zero disables it; service_role and public or signed downloads are exempt.",
    },
    cors_allow_origins: {
      label: "Allowed CORS origins",
      hint: "One exact HTTP(S) origin per line, without paths, trailing slash or credentials. Defaults to any origin; an empty list allows no cross-origin browser access. Does not replace authentication/RLS or grant panel access. Preflights can remain cached for two hours.",
    },
    max_rows: {
      label: "Maximum rows per REST query",
      hint: "Defaults to 1,000. Does not change the SQL editor’s safety budgets.",
    },
    max_body_bytes: {
      label: "Maximum REST request body (bytes)",
      hint: "The body is buffered in memory. Does not control file-upload size.",
    },
    api_concurrency_per_caller: {
      label: "Concurrent REST queries per caller",
      hint: "Defaults to half the pool, at least one. Zero disables the limit; explicit values cannot exceed the pool.",
    },
    db_pool_size: {
      label: "API pool connections",
      hint: "Increasing uses PostgreSQL resources. Does not restart the database; check host capacity.",
    },
    request_timeout_secs: {
      label: "REST request timeout (seconds)",
      hint: "Must exceed the statement timeout when it is enabled.",
    },
    statement_timeout_secs: {
      label: "API SQL statement timeout (seconds)",
      hint: "Zero disables it. A query should finish before the request deadline.",
    },
    storage_max_file_size: {
      label: "Maximum file size (bytes)",
      hint: "Limits new uploads; buckets may set a lower limit. Does not remove existing files.",
    },
    storage_max_total_size: {
      label: "Total file quota (bytes)",
      hint: "No global quota by default. Zero leaves no capacity for new nonempty files. Reducing the quota does not delete existing files.",
    },
    storage_min_free_bytes: {
      label: "Minimum free disk reserve (bytes)",
      hint: "Local storage refuses uploads that violate this reserve. Does not reserve space for other services.",
    },
    storage_upload_timeout_secs: {
      label: "Upload timeout (seconds)",
      hint: "Maximum upload duration, bounded to one day.",
    },
    storage_uploads_per_caller: {
      label: "Concurrent uploads per caller",
      hint: "Up to 32 per caller. Zero disables the individual limit; the global limit of 32 remains.",
    },
  },
};
export default en;
