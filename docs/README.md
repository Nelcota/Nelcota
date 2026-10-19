# Documentation

Choose a guide for your task. Server 0.5.0 is published. Examples target the
current source unless a published version is specified; server and SDK packages
have separate versions. See the [version and upgrade guide](releases/README.md).

The [documentation website](https://nelcota.github.io/NelcotaWebsite/docs/)
renders these same Markdown guides and their existing Portuguese catalogs. Its
pinned source commit identifies the snapshot being read; website updates do not
install a server or SDK package.

## Start

- [Local quickstart](quickstart.md): install, migrate and make an authenticated request.
- [Notes staging](onboarding/notes.md): private notes/files and restart acceptance.
- [Troubleshooting](troubleshooting.md): access, auth, types and limits.

## Build an application

- [REST API](api.md): queries, relations, writes, RPC, OpenAPI and errors.
- [Authentication](schema-auth.md) and [JWT/roles](jwt-and-roles.md): identities, sessions and PostgreSQL authorization.
- [Storage](storage.md): disk/S3, policies, signed URLs and consistency.
- [Webhooks](webhooks.md): durable events, signatures, retries and destination safety.
- [TypeScript SDK](../sdk/typescript/README.md) and [Rust SDK](../sdk/rust/README.md): APIs and lifecycle.
- [Examples](../examples/README.md): schemas and runnable consumers.
- [Auth integration](auth-integration.md): authentication in another Rust application.

## Operate

- [Deploy](deploy.md): Docker/systemd, HTTPS and isolated projects.
- [Backup](backup.md): paired snapshots, offsite copies and database PITR.
- [Controlled updates](panel-updates.md): the 0.5.0 controller and required VPS acceptance.
- [Panel](panel.md): administrative UI and its authority.
- [Host project management](host-management.md): isolated project creation, confirmed backup/restore/removal and persistent recovery.
- [Security model](security/README.md): protections and deployer responsibilities.
- [Release handoff](onboarding/release.md) and [leaving](leaving.md): upgrades and exports.

## Reference

- [Configuration](configuration.md): server fields plus CLI/install/backup settings.
- [CLI](cli.md): commands, options, defaults and destructive operations.
- [Glossary](glossary.md): terminology used throughout these guides.
- [Reporting security issues](../SECURITY.md), [contributing](../CONTRIBUTING.md) and [community conduct](../CODE_OF_CONDUCT.md).

## Design and evidence

- [Architecture](architecture.md): ownership, request lifecycle and budgets.
- [Decisions](decisions.md): historical rationale and superseded choices.
- [Review summary](security/review-summary.md): retained evidence and practical limits.
- [Goals](goals/README.md), [Notes validation](onboarding/validation.md) and [benchmarks](../bench/README.md): dated results, not production guarantees.
- [Native review presets](../presets/README.md): Oxlint/Python and its coverage limits.
- [Translations](i18n/README.md): English guide sources and Portuguese catalogs.

The panel embeds the fixed guide set in its registry. Repository-only references,
indexes and historical reports may need GitHub access; adding a file does not
register a panel guide. Existing paths and section identifiers are preserved
when possible.
