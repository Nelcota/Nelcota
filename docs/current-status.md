# Current implementation and release status

Documentation checkpoint: **2026-10-24**, through SDK release commit `84bc0264` on `main`.
This page connects the day's changes to their current guides. Publication
statements refer to the recorded checkpoint; they are not a new registry or
production validation run.

## Server and installation

The workspace version remains **0.5.3**. The published tag and newer source can
report the same version: retain the commit and artifact hash when identifying a
build. [Unreleased](../CHANGELOG.md#unreleased) lists changes after that tag.

| Area | Current source behavior | Reference |
| --- | --- | --- |
| VPS installer | Arguments enable prerequisite installation, host initialization and startup in `/opt/nelcota`; no arguments retain CLI installation mode | [Deploy](deploy.md) |
| CLI updates | `upgrade --without-controller` permits a guarded fallback on enrolled hosts, subject to controller-job and activation checks | [CLI](cli.md), [controlled updates](panel-updates.md) |
| Panel startup | Saved theme applies before paint; longer starts show animated progress and offline feedback | [Panel](panel.md), [Unreleased](../CHANGELOG.md#unreleased) |
| Panel administration | Confirm privileged tokens and public-bucket changes, mask issued tokens, preserve uncopied webhook keys and improve mobile/database controls | [Panel](panel.md), [Unreleased](../CHANGELOG.md#unreleased) |
| Auth validation | Oversized present refresh tokens return `400 invalid_grant`; absent/empty token validation remains separate | [Unreleased](../CHANGELOG.md#unreleased) |

The installer script is fetched from `main` independently of the downloaded
binary. Its new setup flow can select published 0.5.3 artifacts; a version pin
does not put newer Rust or panel changes into those artifacts. The production
controller still needs the exact-binary VPS acceptance gates before activation.

## Published application SDKs

The current published packages and fresh registry consumers are recorded in the
[TypeScript/Rust receipts](https://github.com/Nelcota/Nelcota/pull/167#issuecomment-6391372294) and
[Next.js acceptance ledger](https://github.com/Nelcota/Nelcota/issues/151).

| SDK | Version | Delivery |
| --- | --- | --- |
| TypeScript | 0.2.3 | npm `@nelcota/client`; independent server PKCE queues and earlier session/query fixes |
| Rust | 0.1.6 | crates.io `nelcota-client`; interrupted error bodies preserve HTTP status and Retry-After |
| Next.js | 0.1.1 | npm `@nelcota/nextjs`; connection reuse and fair PostgreSQL session-lock queueing |

Install commands and upgrade considerations are in [versions and upgrades](releases/README.md).
The [SDK overview](../sdk/README.md) links runtime requirements and source owners.
[PR #167](https://github.com/Nelcota/Nelcota/pull/167) passed 32 checks and fresh
npm/crates.io consumers; [PR #166](https://github.com/Nelcota/Nelcota/pull/166)
records the Next.js correction. The original publication checkpoint remains a
dated record of the earlier package versions.

Next.js supports Server Components, Route Handlers, Server Actions, OAuth and
browser refresh on the Node runtime. The selected matrix uses Next 16.4.3 /
React 19.3.1 with Node 22/24/26; Chromium covers those runtimes and Firefox/WebKit
cover Node 24. The 0.1.1 follow-up adds a separate pinned Next 15 consumer;
it does not validate every previous Next major. Pages Router and Edge remain
outside the supported scope.

Production sessions require a dedicated PostgreSQL store, encryption keys and
direct connections or session pooling. Server Components read only; same-origin
POST routes or Actions own refresh and mutation. Custom SSR integrations must
also coordinate one refresh owner across workers. Read the
[Next.js guide](../sdk/nextjs/README.md) for cookie, lost-response, concurrency
and cleanup requirements before adapting the [example](../sdk/nextjs/examples/app-router/).

## Validation and remaining gates

The [SDK release record](goals/sdk-release-completion.md) retains the executed
unit, type, package-consumer, browser, real auth/RLS/OAuth and S3 checks. The
[contributor guide](../CONTRIBUTING.md) points to reproducible commands and the
sequential test limits. CI now has a reusable Next.js verification workflow;
release workflows retain package-specific gates.

Those results cover the documented disposable fixtures and runtime matrix.
They do not complete production VPS/controller acceptance, a long resource soak,
live OAuth-provider accounts or every S3 provider configuration. Historical
security and performance reports keep their original scope and artifact IDs.

The [documentation website](https://nelcota.github.io/NelcotaWebsite/docs/)
imports a pinned repository revision. Updating these files does not update that
separate website, publish a package or deploy a server.
