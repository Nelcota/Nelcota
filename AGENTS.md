# Notes for coding agents

## Running tests

Keep test runs small and respect the repository resource limits. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, docs/translations and contracts.

- Run only the tests related to what you changed, for example
  `cargo test -p nelcota-server --test rls` or one Vitest file. Don't run the
  whole workspace unless asked.
- Never run the Rust tests and Vitest at the same time, and don't run them
  alongside `cargo deny` / `cargo audit`. One thing at a time.
- Prefer `scripts/test.sh`, which runs at low priority (`nice`/`ionice`) and
  runs suites one after another:

  ```sh
  scripts/test.sh rust -p nelcota-server --test rls
  scripts/test.sh ui src/lib/features/guides/content.test.ts
  scripts/test.sh all        # only when asked
  ```

- Limits are already set: `.cargo/config.toml` sets `RUST_TEST_THREADS=2` and
  `jobs = 4`; Vitest uses `maxWorkers: 2` (`crates/admin/ui/vite.config.ts`).
  Don't pass higher `--test-threads` values.

## Shared Postgres for Rust integration tests

Without `NELCOTA_TEST_DATABASE_URL`, every `TestApp` starts its own Postgres
container, which is slow and CPU-heavy. Locally, use one shared container
instead (each test still gets its own database):

```sh
scripts/test.sh db   # starts nelcota-test-postgres on 127.0.0.1:55432 if needed
export NELCOTA_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
cargo test -p nelcota-server --test rls
```

`scripts/test.sh rust ...` does both steps for you and drops the leftover
`nelcota_test_*` databases afterwards (the harness doesn't manage to drop
them). If you run `cargo test` by hand against the shared container, the
databases pile up in RAM; `docker rm -f nelcota-test-postgres` clears them. It stops with an error if
Docker isn't reachable; don't work around that by running without the shared
database. If the user was just added to the `docker` group, use
`sg docker -c "scripts/test.sh ..."`.

The container keeps its data in tmpfs; remove it with
`docker rm -f nelcota-test-postgres`.

## JavaScript and TypeScript standards

Follow [the NelcotaRules integration](docs/engineering/nelcota-rules.md), including
its upstream provenance, checked JavaScript/JSDoc and explicit REST execution.
Fix violations at their source; do not hide them with blanket ignores. Preserve
published contracts and generated files through their established workflows.
