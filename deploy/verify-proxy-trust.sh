#!/usr/bin/env bash
# ── Proxy-trust verification for the Caddy production topology ──────────
#
# Fixes CONFIG-001 asked for two guarantees; this script checks both.
#
#   (1) SPOOF RESISTANCE — the edge must overwrite X-Forwarded-For, so a
#       client cannot mint a fresh per-IP budget by rotating the header.
#
#       ./verify-proxy-trust.sh https://signal.example.com
#
#       Sends RATE_LIMIT_PER_MIN+N requests to /api/health, each with a
#       DIFFERENT spoofed X-Forwarded-For. The per-IP limiter must trip
#       (HTTP 429). If every request returns 200, the header leaked through
#       and every IP-keyed defence in the server is bypassable.
#
#   (2) NO IP COLLAPSE — distinct users must not share one budget. Right
#       after (1) has tripped the limiter, run this from a DIFFERENT network
#       (phone hotspot, second host):
#
#       ./verify-proxy-trust.sh https://signal.example.com --fresh
#
#       It sends ONE request and requires 200. A 429 means the server is
#       attributing every user to the same address — the classic symptom of
#       TRUST_PROXY being unset while sitting behind a proxy.
#
# Both checks are read-only: /api/health creates no sessions or nodes. The
# limiter window is 60s, so wait a minute between runs.
#
# Requires: bash, curl.

set -euo pipefail

BASE="${1:-}"
MODE="${2:-burst}"

if [ -z "$BASE" ]; then
  echo "usage: $0 <https://signal.example.com> [--fresh]" >&2
  exit 2
fi
BASE="${BASE%/}"

status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "X-Forwarded-For: $1" \
    -H "X-Real-IP: $1" \
    -H "Forwarded: for=$1" \
    "$BASE/api/health"
}

if [ "$MODE" = "--fresh" ]; then
  code="$(status 198.51.100.7)"
  if [ "$code" = "429" ]; then
    echo "FAIL: this client is already rate-limited from a network that never"
    echo "      called the server. Users are collapsing onto one IP — check"
    echo "      TRUST_PROXY in docker-compose.prod.yml and the header_up"
    echo "      rules in the Caddyfile."
    exit 1
  fi
  echo "PASS: fresh network got HTTP $code (not 429) — per-IP budgets are distinct."
  exit 0
fi

# RATE_LIMIT_PER_MIN defaults to 60 in docker-compose.prod.yml.
LIMIT="${RATE_LIMIT_PER_MIN:-60}"
ATTEMPTS=$(( LIMIT + 10 ))

echo "Sending $ATTEMPTS requests to $BASE/api/health with distinct spoofed XFF..."
saw429=0
for i in $(seq 1 "$ATTEMPTS"); do
  code="$(status "203.0.113.$(( i % 254 + 1 ))")"
  if [ "$code" = "429" ]; then saw429=1; echo "  -> 429 after $i requests"; break; fi
  if [ "$code" != "200" ]; then echo "  unexpected HTTP $code at request $i" >&2; fi
done

if [ "$saw429" -ne 1 ]; then
  echo "FAIL: $ATTEMPTS requests with $ATTEMPTS different X-Forwarded-For values"
  echo "      were never rate-limited. The edge is forwarding the client's own"
  echo "      header — add the request_header/header_up rules from"
  echo "      Caddyfile.example, or the server is running with a hop count"
  echo "      higher than the real topology."
  exit 1
fi

echo "PASS: spoofed X-Forwarded-For did not create new per-IP budgets."
echo "Now run, from a different network:  $0 $BASE --fresh"
