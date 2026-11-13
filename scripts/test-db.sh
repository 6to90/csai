#!/usr/bin/env bash
# Runs migrations on a throwaway local Postgres (NOT Supabase) and executes the DB tests. Requires Homebrew postgresql@17.
set -euo pipefail
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
DIR="$(mktemp -d)"; PORT="${PGPORT_TEST:-54329}"
trap '"$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
"$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$DIR/log" -w start >/dev/null
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres
"$PGBIN/createdb" app
PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q -d app"
$PSQL -f supabase/tests/bootstrap_local.sql
for f in supabase/migrations/*.sql; do echo "migrate $f"; $PSQL -f "$f"; done
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/app" pnpm exec vitest run tests/db "$@"
