#!/usr/bin/env bash
# End-to-end smoke test: create ticket, watch state, approve, confirm, show audit trail.
set -euo pipefail

BASE=${BASE:-http://localhost:8000}
TICKET_ID=""

echo ">>> health"
curl -s "$BASE/health" && echo

echo ">>> creating ticket: alice locked out"
RESP=$(curl -s -X POST "$BASE/tickets/" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"reporter":"Alice Nguyen","reporterEmail":"alice@acme.test",
       "subject":"AD account locked","body":"Cannot log in this morning"}')
echo "$RESP"
TICKET_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "ticket: $TICKET_ID"

echo ">>> waiting for awaiting_approval ..."
for _ in $(seq 1 40); do
  STATUS=$(curl -s "$BASE/tickets/$TICKET_ID" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  echo "  status=$STATUS"
  if [ "$STATUS" = "awaiting_approval" ]; then break; fi
  sleep 0.5
done

echo ">>> approve"
curl -s -X POST "$BASE/tickets/$TICKET_ID/approve" && echo

echo ">>> waiting for awaiting_confirmation ..."
for _ in $(seq 1 40); do
  STATUS=$(curl -s "$BASE/tickets/$TICKET_ID" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  echo "  status=$STATUS"
  if [ "$STATUS" = "awaiting_confirmation" ] || [ "$STATUS" = "escalated" ]; then break; fi
  sleep 0.5
done

if [ "$STATUS" = "awaiting_confirmation" ]; then
  echo ">>> user confirms"
  curl -s -X POST "$BASE/tickets/$TICKET_ID/confirm" \
    -H "Content-Type: application/json" \
    -d '{"resolved":true}' && echo
  for _ in $(seq 1 20); do
    STATUS=$(curl -s "$BASE/tickets/$TICKET_ID" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
    echo "  status=$STATUS"
    if [ "$STATUS" = "resolved" ]; then break; fi
    sleep 0.5
  done
fi

echo ">>> audit trail"
psql ${DATABASE_URL_SYNC:-postgresql://it_copilot:it_copilot@localhost:5432/it_copilot} \
  -c "SELECT actor, action, created_at FROM audit_entries WHERE ticket_id='$TICKET_ID' ORDER BY created_at;"
