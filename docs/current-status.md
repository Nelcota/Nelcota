# Current implementation and release status

Documentation checkpoint: **2026-10-27**, server 0.5.5 scope after the outbound
address policy (#191) and the panel performance work (#193–#199). SDK publication statements use the
[October 26 receipts](https://github.com/Nelcota/Nelcota/pull/181#issuecomment-6423930169); this page does not
claim another production validation run. Verify server artifact availability and signed readiness on the
[release page](https://github.com/Nelcota/Nelcota/releases/tag/v0.5.5).

## Server and installation

The workspace targets **0.5.5**. Its [release notes](releases/0.5.5.en.md) include
the changes developed after published 0.5.4. A version number in source does not
publish an artifact: retain the tag, source and artifact hash when identifying
a build. Future changes are listed under [Unreleased](../CHANGELOG.md#unreleased).

| Area | Current source behavior | Reference |
| --- | --- | --- |
| VPS installer | Arguments enable prerequisite installation, host initialization and startup in `/opt/nelcota`; no arguments retain CLI installation mode | [Deploy](deploy.md) |
| CLI updates | `upgrade --without-controller` permits a guarded fallback on enrolled hosts, subject to controller-job and activation checks | [CLI](cli.md), [controlled updates](panel-updates.md) |
| Panel startup | Saved theme applies before paint; longer starts show animated progress and offline feedback | [Panel](panel.md), [0.5.4 notes](releases/0.5.4.en.md) |
| Panel administration | Confirm privileged tokens and public-bucket changes, mask issued tokens, preserve uncopied webhook keys and improve mobile/database controls | [Panel](panel.md), [0.5.4 notes](releases/0.5.4.en.md) |
| File integrity | Retain uncertain publications and durably quarantine ambiguous/shared physical targets | [Storage](storage.md) |
| Auth and queries | Serialize refresh by session, preserve literal admin identifiers and reject oversized present refresh tokens with `400 invalid_grant` | [0.5.4 notes](releases/0.5.4.en.md) |
| Panel loading | Each language and guide loads on demand, a returning browser prefetches its shell, assets are brotli-precompressed and large SQL results are virtualized | [Panel](panel.md), [0.5.5 notes](releases/0.5.5.en.md) |
| Outbound destinations | Project and host alert webhooks share one public-address policy; host management keeps a looser check for the operator's own servers | [Decisions](decisions.md), [0.5.5 notes](releases/0.5.5.en.md) |

The installer script is fetched from `main` independently of the downloaded
binary. Select and verify matching artifacts for the chosen version; a version
pin does not put newer source into older binaries. Update CLI and application/
controller together. The production controller still needs the exact-binary VPS
acceptance gates before activation.

## Published application SDKs

The current published packages and fresh registry consumers are recorded in the
[TypeScript/Rust receipts](https://github.com/Nelcota/Nelcota/pull/167#issuecomment-6391372294) and
[Next.js acceptance ledger](https://github.com/Nelcota/Nelcota/issues/151).

| SDK | Version | Delivery |
| --- | --- | --- |
| TypeScript | 0.2.5 | npm `@nelcota/client`; faster JSON parsing of large responses, refresh retry inside the server reuse window, Date/bigint JSON guards |
| Rust | 0.1.7 | crates.io `nelcota-client`; shared refresh under the client timeout, due-session rotation |
| Next.js | 0.1.2 | npm `@nelcota/nextjs`; proxy keeps row-less cookies a sign-in may have replaced |

Install commands and upgrade considerations are in [versions and upgrades](releases/README.md).
The [SDK overview](../sdk/README.md) links runtime requirements and source owners.
[PR #167](https://github.com/Nelcota/Nelcota/pull/167) passed 32 checks and fresh
npm/crates.io consumers; [PR #166](https://github.com/Nelcota/Nelcota/pull/166)
records the Next.js correction. The original publication checkpoint remains a
dated record of the earlier package versions.

Next.js supports Server Components, Route Handlers, Server Actions, OAuth and
browser refresh on the Node.js-compatible runtime of Bun or Node. The selected
matrix uses Next 16.4.3 / React 19.3.1 on Bun 1.4.3 with Chromium, Firefox and
WebKit, plus Node 22/24/26 with Chromium. The 0.1.1 follow-up adds a separate pinned Next 15 consumer;
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
