#!/usr/bin/env bash
# Runs the suites against the REAL local Supabase stack (`supabase start`: GoTrue, PostgREST, Kong, Mailpit, Postgres).
# LOCAL ONLY: refuses to run unless the API is on 127.0.0.1. Never prints keys.
set -euo pipefail
supabase status >/dev/null 2>&1 || { echo "local Supabase is not running (supabase start)"; exit 2; }
ENVF="$(supabase status -o env 2>/dev/null)"
getv() { printf '%s\n' "$ENVF" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
API_URL="$(getv API_URL)"; DB_URL="$(getv DB_URL)"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: API_URL is not local"; exit 2;; esac
export SUPABASE_URL="$API_URL" ANON_KEY="$(getv ANON_KEY)" SERVICE_KEY="$(getv SERVICE_ROLE_KEY)" JWT_SECRET="$(getv JWT_SECRET)"
# The stack must have been started with SUPABASE_AUTH_CAPTCHA_SECRET set to a Cloudflare DUMMY secret (public test value, never a real one).
export NEXT_PUBLIC_TURNSTILE_SITE_KEY="${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-1x00000000000000000000AA}"
export MAIL_URL="${MAIL_URL:-http://127.0.0.1:54324}" TEST_DATABASE_URL="$DB_URL" REAL_SUPABASE=1
[ -n "$ANON_KEY" ] && [ -n "$SERVICE_KEY" ] && [ -n "$JWT_SECRET" ] || { echo "missing keys from supabase status"; exit 2; }

WEBP=3112; PIDS=(); LOG="$(mktemp)"
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -f "$LOG" "$LOG.mail" "$LOG.build"' EXIT
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY"
export SECRETS_MASTER_KEY="$(openssl rand -base64 32)"   # throwaway per run; encrypts channel secrets in the local DB only
export CSAI_TEST_BUILD=1 SMTP_ALLOW_PRIVATE_HOSTS=1   # TEST BUILD ONLY: lets tests point a channel at a local fake SMTP server (a production build ignores both)
export CRON_SECRET="test-cron-secret-value" RATE_LIMIT_SALT="test-salt" APP_URL="http://127.0.0.1:$WEBP" TRUSTED_PROXY_HOPS=1
pnpm exec next build >"$LOG.build" 2>&1 || { tail -20 "$LOG.build"; exit 1; }
export NEXT_LOG="$LOG"
pnpm exec next start -p $WEBP >"$NEXT_LOG" 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$WEBP/api/v1/health" >/dev/null && break; sleep 0.5; done
# Second server from the SAME build, with a real mail transport (Mailpit): tests/real/mailbox-proof.test.ts receives invitation links and
# verification codes through an actual mailbox, like a real invitee. The first server has no transport (links come back in the response).
WEBM=3113
MAIL_TRANSPORT=mailpit MAIL_HTTP_URL="$MAIL_URL" APP_URL="http://127.0.0.1:$WEBM" pnpm exec next start -p $WEBM >"$NEXT_LOG.mail" 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$WEBM/api/v1/health" >/dev/null && break; sleep 0.5; done
export API_BASE_MAIL="http://127.0.0.1:$WEBM"
export API_BASE="http://127.0.0.1:$WEBP" STATIC_DIR="$PWD/.next/static"
if [ $# -eq 0 ]; then set -- tests/db tests/api tests/real; fi
pnpm exec vitest run --no-file-parallelism "$@"
