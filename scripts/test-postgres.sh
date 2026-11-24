#!/usr/bin/env bash
# Run the Teams mode (Postgres) tests: starts a throwaway postgres:17-alpine container, runs the tests in the dev
# container (scripts/npm.sh) against it, and removes the container again.
#   ./scripts/test-postgres.sh                       # test/teams.e2e.test.ts and test/audit.e2e.test.ts
#   ./scripts/test-postgres.sh test/other.test.ts    # other test files (relative to server/)
# STUBYARD_TEST_PG_PORT (default 48901) is the host port the database is published on (127.0.0.1 only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${STUBYARD_TEST_PG_PORT:-48901}"
NAME="stubyard-test-pg-$$"
PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_USER=stubyard -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB=stubyard_test \
  postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U stubyard -d stubyard_test -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")"
FILES=("$@")
[ ${#FILES[@]} -eq 0 ] && FILES=(test/teams.e2e.test.ts test/audit.e2e.test.ts)
STUBYARD_DOCKER_ARGS="-e STUBYARD_TEST_DATABASE_URL=postgres://stubyard:$PASS@$IP:5432/stubyard_test ${STUBYARD_DOCKER_ARGS:-}" \
  "$ROOT/scripts/npm.sh" test -w server -- "${FILES[@]}"
