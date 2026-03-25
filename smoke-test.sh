#!/usr/bin/env bash
# Smoke test for Odoo Sync service (Node.js HTTP server on Cloud Run).
# Usage: ./smoke-test.sh [base-url]
# Example: ./smoke-test.sh http://localhost:8080
#
# Note: GET / and GET /sync trigger a full sync run, so they may take a while
# and could return 500 if env vars (SOURCE_*, STATE_*) are not configured.
# This script only checks that the endpoints are reachable and respond with
# a valid HTTP status (i.e. not 000/timeout).

set -euo pipefail
BASE_URL="${1:-http://localhost:8080}"
# Strip trailing slash
BASE_URL="${BASE_URL%/}"
PASSED=0
FAILED=0

check() {
    local name="$1" url="$2" expected="${3:-200}" method="${4:-GET}" body="${5:-}"
    local status
    if [ "$method" = "POST" ]; then
        status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
            -H "Content-Type: application/json" -d "${body:-{}}" --max-time 30 2>/dev/null || echo "000")
    else
        status=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 30 2>/dev/null || echo "000")
    fi
    if [ "$status" = "$expected" ]; then
        echo "  PASS  $name (HTTP $status)"
        PASSED=$((PASSED + 1))
    else
        echo "  FAIL  $name (expected HTTP $expected, got $status)"
        FAILED=$((FAILED + 1))
    fi
}

# Reachability check: any HTTP response (not a timeout/connection refused).
check_reachable() {
    local name="$1" url="$2" method="${3:-GET}" body="${4:-}"
    local status
    if [ "$method" = "POST" ]; then
        status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
            -H "Content-Type: application/json" -d "${body:-{}}" --max-time 30 2>/dev/null || echo "000")
    else
        status=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 30 2>/dev/null || echo "000")
    fi
    if [ "$status" != "000" ]; then
        echo "  PASS  $name (HTTP $status — reachable)"
        PASSED=$((PASSED + 1))
    else
        echo "  FAIL  $name (connection failed or timed out)"
        FAILED=$((FAILED + 1))
    fi
}

echo "Smoke testing Odoo Sync: $BASE_URL"
echo "---"

# 1. Root endpoint reachable — GET / triggers a sync, may return 200 or 500
#    depending on env config. We just verify the server responds.
check_reachable "GET / (server responds)" "$BASE_URL/"

# 2. Sync endpoint reachable — GET /sync is equivalent to GET /
check_reachable "GET /sync (server responds)" "$BASE_URL/sync"

# 3. Webhook endpoint reachable — POST /webhook should respond (200 or 401
#    depending on whether WEBHOOK_SECRET is set)
check_reachable "POST /webhook (server responds)" "$BASE_URL/webhook" POST '{}'

# 4. Unknown route — should return 404
check "GET /nonexistent (-> 404)" "$BASE_URL/nonexistent" 404 GET

# 5. Wrong method on webhook — only POST is handled, GET should return 404
check "GET /webhook (wrong method -> 404)" "$BASE_URL/webhook" 404 GET

echo "---"
echo "Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -gt 0 ] && exit 1
exit 0
