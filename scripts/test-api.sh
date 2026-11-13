#!/usr/bin/env bash
# HTTP-level API tests: real Next.js server + REAL PostgREST + real Postgres, with a JWT/user-lookup STUB instead of GoTrue
# (scripts/auth-stub.mjs). Used when Docker (supabase start) is unavailable. Requires: postgresql@17, postgrest (brew).
set -euo pipefail
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
DIR="$(mktemp -d)"; PGP="${PGP:-54331}"; PRP="${PRP:-54320}"; AUTHP="${AUTHP:-54321}"; WEBP="${WEBP:-3112}"   # override to run beside a dev stack
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PGP -k $DIR -c listen_addresses=127.0.0.1 -c max_connections=200" -l "$DIR/pg.log" -w start >/dev/null
export PGHOST=127.0.0.1 PGPORT=$PGP PGUSER=postgres
"$PGBIN/createdb" app
PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q -d app"
$PSQL -f supabase/tests/bootstrap_local.sql
for f in supabase/migrations/*.sql; do $PSQL -f "$f" 2>&1 | grep -v NOTICE || true; done

export JWT_SECRET="test-only-jwt-secret-at-least-32-chars-long!!"
mint() { node -e '
const c=require("node:crypto"),b=x=>Buffer.from(x).toString("base64url");
const h=b(JSON.stringify({alg:"HS256",typ:"JWT"})),p=b(JSON.stringify({role:process.argv[1],iss:"test",exp:Math.floor(Date.now()/1000)+86400}));
console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))' "$1"; }
export ANON_KEY="$(mint anon)" SERVICE_KEY="$(mint service_role)"
cat > "$DIR/postgrest.conf" <<EOF
db-uri = "postgres://authenticator@127.0.0.1:$PGP/app"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $PRP
EOF
postgrest "$DIR/postgrest.conf" >"$DIR/postgrest.log" 2>&1 & PIDS+=($!)
DATABASE_URL="postgres://postgres@127.0.0.1:$PGP/app" PORT=$AUTHP POSTGREST_PORT=$PRP node scripts/auth-stub.mjs & PIDS+=($!)
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PRP/" >/dev/null && break; sleep 0.5; done

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$AUTHP" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY"
export SECRETS_MASTER_KEY="$(openssl rand -base64 32)"   # throwaway per run; encrypts channel secrets in the local DB only
export SMTP_ALLOW_PRIVATE_HOSTS=1   # set on purpose on a NON-test build: tests/api/smtp-guard.test.ts proves a production build ignores it
export CRON_SECRET="test-cron-secret-value" RATE_LIMIT_SALT="test-salt" APP_URL="http://127.0.0.1:$WEBP"
pnpm exec next build >"$DIR/build.log" 2>&1 || { tail -20 "$DIR/build.log"; exit 1; }
export NEXT_LOG="$DIR/next.log"
pnpm exec next start -p $WEBP >"$NEXT_LOG" 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$WEBP/api/v1/health" >/dev/null && break; sleep 0.5; done

export API_BASE="http://127.0.0.1:$WEBP" SUPABASE_URL="http://127.0.0.1:$AUTHP" TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PGP/app" STATIC_DIR="$PWD/.next/static"
pnpm exec vitest run tests/api "$@" || { rc=$?; [ -n "${SHOW_LOGS:-}" ] && { echo "--- next.log"; tail -30 "$NEXT_LOG"; echo "--- postgrest.log"; tail -15 "$DIR/postgrest.log"; }; exit $rc; }
