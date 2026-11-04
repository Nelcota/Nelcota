# Authentication email templates

This describes the current checkout, not an already published release. Recovery,
confirmation and magic-link messages remain **plain text**, not HTML. English is
the default; `pt-BR` selects Portuguese defaults, including existing-account signup
notices. Each subject/message can independently keep its language default or use
an override. Keep credentials out of templates.

## Panel workflow and authority

Use **Server → Settings → Project settings → Transactional emails and links**
with matching server/controller versions. The enrolled host operator edits the
ten email fields in the existing reviewed batch: complete-candidate validation,
source/project revision checks, explicit confirmation, private persistence,
one application restart and configuration-only rollback/recovery. Other projects
and database contents are unchanged. A project-panel session does not grant host
configuration authority. Unsupported runtime/file layouts remain blocked.

The panel accepts decoded text. Newlines, apostrophes, dollar signs, backslashes
and Unicode are preserved through explicitly encoded persistence, not interpreted
as environment-file syntax. Subjects allow 200 UTF-8 bytes; messages allow 2048.
Subjects cannot contain control characters or line separators. Messages accept
LF newlines and tabs, not CR/NUL or other controls. Unknown/malformed placeholders
and oversized worst-case rendered output fail before configuration is applied.

| Variable | Meaning | Subject | Message |
| --- | --- | --- | --- |
| `{{project_name}}` | Configured project name, or Nelcota | Yes | Yes |
| `{{validity}}` | Actual configured lifetime, localized | Yes | Yes |
| `{{email}}` | Recipient account email | No | Yes |
| `{{link}}` | Complete single-use link; token stays in the fragment | No | Exactly once |

Substitutions are single-pass: values never become another template expression.
There is no expression engine, remote include, raw HTML preview or template URL.
Render output is bounded to 512 subject bytes / 16 KiB message bytes, including
the worst permitted substitutions. The template editor uses UTF-8 byte limits,
not merely JavaScript character counts.

## Preview and test

**Preview draft** renders the current unsaved selection on the backend using the
same renderer as actual delivery. It uses a fictional project/address and a
reserved `example.invalid` link whose marker was never issued or stored as an
authentication token. It needs no SMTP and never saves the draft.

**Send test draft** uses only the current project's already applied SMTP
configuration and its fixed `NELCOTA_ADMIN_EMAIL` recipient. There is no
request-supplied recipient, SMTP URL, credential or link destination. Open that
project's own panel when a host operator has selected a different project.
Panel session and same-origin protection are required. The message is marked
`[TEST]`, uses the same fictional values and creates no account/session/token.

Tests share the existing mail admission/deadline and allow one attempt per minute
per running process, including failed attempts. Overload before admission does
not spend that cooldown. SMTP acceptance is not proof of inbox delivery. A
timeout/lost response is not proof that nothing was sent; there is no automatic
retry. Provider diagnostics, message bodies and recipients are not logged or
returned in errors. Credentials remain write-only in the separate SMTP workflow.

The project-admin API exposes `GET /admin/api/email`,
`POST /admin/api/email/preview` and `POST /admin/api/email/test`. Preview/test JSON
contains `project`, `kind` (recovery/signup/magiclink), `language` (en/pt-BR),
nullable `subject`/`text` overrides and integer `ttl_minutes`. Unknown fields are
rejected. These operations do not expose or modify the host environment.

## Link lifetimes

| Kind | Default | Allowed minutes |
| --- | --- | --- |
| Recovery | 60 minutes | 5–1440 |
| Signup confirmation | 1440 minutes | 5–10080 |
| Magic link | 15 minutes | 1–60 |

These values control the database expiration of **new** links and the validity
shown in their emails. Changing a value does not extend, revoke or rewrite links
already issued. Per-account issuance cooldowns, hashed-only token storage,
atomic single-use consumption, PKCE, password/session revocation and
non-enumerating public responses are unchanged. Link pages must be HTTP(S), at
most 2048 bytes, with a host and no credentials, fragment or whitespace. Use
HTTPS outside local development. Keep passwordless-link lifetimes short.

## Standalone startup configuration

See the exact names in the [configuration reference](configuration.md). For a
hand-managed process, generate padded RFC 4648 base64 from the UTF-8 template:

```sh
python3 - <<'PY'
import base64
text = "Hello {{email}}!\n\nOpen {{link}} within {{validity}}.\n{{project_name}}\n"
print(base64.b64encode(text.encode("utf-8")).decode("ascii"))
PY
```

Set that output as `NELCOTA_EMAIL_RECOVERY_TEXT_BASE64` in the private service
environment, without adding an extra escaping layer. A TOML file uses
`email_recovery_text_base64` with the same encoded string. Set
`NELCOTA_EMAIL_LANGUAGE=pt-BR` and the desired minute fields independently.
Unset an override to restore its language default; an empty encoded template is
not a reset. Base64 is **not encryption**. Preserve private file permissions and
the independent CLI/SSH recovery path. Standalone auth consumers can opt in with
`MailDelivery::with_email_settings`; existing `AuthSettings` construction remains
unchanged.

## Verification limits

Related unit, browser and real-PostgreSQL results are dated in the
[delivery ledger](goals/panel-configuration.md). Owned Docker/TLS-provider
fixtures do not establish real VPS/systemd, public DNS/TLS, external-provider
inbox delivery, S3 migration or PITR acceptance. No release/deployment is implied.
