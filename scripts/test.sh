#!/usr/bin/env bash
# Run the test suites one after another at low priority.
#
#   scripts/test.sh db                     start the shared test Postgres, print the export line
#   scripts/test.sh rust [cargo args...]   e.g. scripts/test.sh rust -p nelcota-server --test rls
#   scripts/test.sh ui [vitest args...]    e.g. scripts/test.sh ui src/lib/navigation/route-match.test.ts
#   scripts/test.sh all                    Rust, then Vitest (never in parallel)
#
# Rust integration tests use one shared Postgres container (a database per
# test) through NELCOTA_TEST_DATABASE_URL instead of one container per test.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container=nelcota-test-postgres
port="${NELCOTA_TEST_PG_PORT:-55432}"
url="postgres://postgres:postgres@127.0.0.1:${port}/postgres"
args="$*"

low() { nice -n 19 ionice -c3 "$@"; }

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    cat >&2 <<EOF
error: cannot reach Docker (docker info failed).
The Rust integration tests need the shared Postgres container, so nothing was run.
If your user was just added to the 'docker' group, log out and back in,
or run this script through: sg docker -c "scripts/test.sh ${args}"
EOF
    exit 1
  fi
}

start_db() {
  require_docker
  if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker run -d --name "$container" \
      -e POSTGRES_PASSWORD=postgres \
      -p "127.0.0.1:${port}:5432" \
      --tmpfs /var/lib/postgresql/data \
      postgres:17-alpine \
      postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
        -c max_connections=300 -c shared_preload_libraries=pg_stat_statements >/dev/null
  fi
  # -h forces TCP, so the temporary server used during initdb doesn't count as ready.
  for _ in $(seq 60); do
    if docker exec "$container" pg_isready -q -h 127.0.0.1 -U postgres; then
      return 0
    fi
    sleep 0.5
  done
  echo "error: $container did not become ready; see: docker logs $container" >&2
  exit 1
}

run_rust() {
  start_db
  export NELCOTA_TEST_DATABASE_URL="$url"
  local status=0
  (cd "$root" && low cargo test "$@") || status=$?
  drop_test_databases
  return "$status"
}

# The harness drops its database in Drop, but the test runtime is already
# shutting down by then, so the databases stay behind (and the data lives in tmpfs).
drop_test_databases() {
  # Quote names in Postgres instead of interpolating database identifiers.
  docker exec -i "$container" psql -q -U postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT format('DROP DATABASE %I WITH (FORCE)', datname)
FROM pg_database WHERE datname LIKE 'nelcota\_test\_%'
\gexec
SQL
}

run_ui() {
  (cd "$root/crates/admin/ui" && low npx vitest run "${@:-src}")
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  db)
    start_db
    echo "export NELCOTA_TEST_DATABASE_URL=$url"
    ;;
  rust) run_rust "$@" ;;
  ui) run_ui "$@" ;;
  all)
    run_rust --workspace
    run_ui
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
