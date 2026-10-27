# Security

Use this policy to report a suspected vulnerability privately and determine
which versions receive fixes. Deployment responsibilities are in
[the security model](docs/security/README.md).

## Reporting a vulnerability

Do not open a public issue or post credentials/exploit details. Use
[GitHub private vulnerability reporting](https://github.com/Nelcota/Nelcota/security/advisories/new)
(Security → Report a vulnerability). If you cannot access that form, contact
`financeiro@hanielfialho.com` to arrange a private report; do not include live
secrets in the initial message.

Include the affected version/commit, platform, a minimal private reproduction,
expected/actual behavior and likely impact. Redact tokens, personal data and
infrastructure secrets. Maintainers aim to acknowledge reports within three
business days and provide an initial assessment within fourteen calendar days.
These are best-effort targets, not a guaranteed response or remediation SLA.

Coordinate disclosure with maintainers. Fix timing depends on impact and a
verified correction. Publish details after a fix or an agreed disclosure date;
maintainers credit reporters unless they prefer anonymity. If progress stalls,
use the same private thread to agree next steps rather than exposing user data.

## Supported versions

| Component | Receives fixes |
| --- | --- |
| Latest published server release | Yes; corrections may first land in main and ship in the next release. See the [version guide](docs/releases/README.md). |
| Latest published TypeScript/Rust SDKs | Yes, released independently of the server. See the [SDK release guides](CONTRIBUTING.md#sdks). |
| Older releases | No routine backports; upgrade and review compatibility notes. |
| main/source candidates | Development fixes; not a production acceptance guarantee. |

A green CI run does not mean a published artifact includes a newer fix. Check
[Unreleased](CHANGELOG.md#unreleased) and the SDK changelogs. To update a project,
install the target release's CLI first, take a verified database/file backup,
then use the documented upgrade procedure. `nelcota upgrade` alone targets the
installed CLI version; it does not download a newer CLI or update installed SDKs.
Enrolled hosts use their separate update controller.

## Scope

Report bypasses of intended RLS/GRANT boundaries, role/signature validation,
admin authentication, storage path/content controls, outbound destination
restrictions, resource bounds, release trust or secret handling. A leaked
`service_role` token deliberately bypasses RLS, but the cause of a leak can
still be a vulnerability and should be assessed privately.

Do not test other people's deployments without authorization. Use disposable
fixtures for security tests. Host root, database administrators and project
panel administrators have privileged access by design.

## Verifying a release

Download matching binary/checksum assets from the official release and verify
before installing:

```sh
sha256sum -c nelcota-x86_64-unknown-linux-musl.sha256
gh attestation verify nelcota-x86_64-unknown-linux-musl -R Nelcota/Nelcota
gh attestation verify oci://ghcr.io/nelcota/nelcota-server:0.5.6 -R Nelcota/Nelcota
```

Use the corresponding arm64 filename when needed. Checksums detect mismatched
bytes; provenance also establishes the repository/build identity. Never bypass
TLS/checksum/signature failure. Controlled updates additionally verify signed
readiness, exact source and immutable artifact identities; see
[the operating guide](docs/panel-updates.md).
