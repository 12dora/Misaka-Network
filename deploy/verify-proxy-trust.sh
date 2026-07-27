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
  local path="${2:-/api/health}"
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "X-Forwarded-For: $1" \
    -H "X-Real-IP: $1" \
    -H "Forwarded: for=$1" \
    "$BASE$path"
}

check_ws_boundary() {
  local code
  code="$(status "198.51.100.7" "/ws")"
  # A plain HTTP request to the WebSocket endpoint is rejected by ws with
  # 400/426. 404 means the edge is not routing /ws to this Misaka backend.
  if [ "$code" != "400" ] && [ "$code" != "426" ]; then
    echo "FAIL: /ws compatibility probe expected HTTP 400/426, got $code" >&2
    exit 1
  fi
}

if [ "$MODE" = "--fresh" ]; then
  code="$(status 198.51.100.7)"
  if [ "$code" != "200" ]; then
    echo "FAIL: this client is already rate-limited from a network that never"
    echo "      called the server, or the endpoint is unhealthy (HTTP $code)."
    echo "      Require exactly HTTP 200; inspect TRUST_PROXY, Caddy routing and"
    echo "      the signaling health endpoint."
    exit 1
  fi
  check_ws_boundary
  echo "PASS: fresh network got HTTP 200 and /ws reaches a compatible upgrade endpoint."
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
  if [ "$code" != "200" ]; then
    echo "FAIL: unexpected HTTP $code at request $i" >&2
    exit 1
  fi
done

if [ "$saw429" -ne 1 ]; then
  echo "FAIL: $ATTEMPTS requests with $ATTEMPTS different X-Forwarded-For values"
  echo "      were never rate-limited. The edge is forwarding the client's own"
  echo "      header. Caddy must trust only published CDN CIDRs, overwrite from"
  echo "      validated {client_ip}, and signaling must remain TRUST_PROXY=1."
  exit 1
fi

check_ws_boundary
echo "PASS: spoofed X-Forwarded-For did not create new per-IP budgets."
echo "Now run, from a different network:  $0 $BASE --fresh"
