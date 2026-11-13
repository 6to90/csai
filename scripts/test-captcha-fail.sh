#!/usr/bin/env bash
# Restarts the LOCAL stack with Cloudflare's dummy always-FAIL Turnstile secret, runs the rejection test, then restores the always-PASS secret.
set -euo pipefail
PASS=1x0000000000000000000000000000000AA; FAIL=2x0000000000000000000000000000000AA
restart() { SUPABASE_AUTH_CAPTCHA_SECRET="$1" supabase stop >/dev/null 2>&1; SUPABASE_AUTH_CAPTCHA_SECRET="$1" supabase start >/dev/null 2>&1; }
trap 'restart "$PASS"' EXIT
restart "$FAIL"
ENVF="$(supabase status -o env 2>/dev/null)"; getv() { printf '%s\n' "$ENVF" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
case "$(getv API_URL)" in http://127.0.0.1:*) ;; *) echo "refusing: not local"; exit 2;; esac
SUPABASE_URL="$(getv API_URL)" ANON_KEY="$(getv ANON_KEY)" CAPTCHA_FAIL=1 pnpm exec vitest run tests/real-captcha-fail
