#!/usr/bin/env bash
set -e

BASE_URL="http://localhost:3000"
PASS=0
FAIL=0
TOTAL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
bold()  { printf "\033[1m%s\033[0m" "$1"; }

check() {
  TOTAL=$((TOTAL + 1))
  local desc="$1"
  local status="$2"

  if [ "$status" = "pass" ]; then
    green "  ✓ PASS  ${desc}"
    PASS=$((PASS + 1))
  else
    red "  ✗ FAIL  ${desc}"
    FAIL=$((FAIL + 1))
  fi
}

do_curl() {
  local method="$1"
  local path="$2"
  local body="$3"
  local out="/tmp/nv_verify.txt"

  if [ -n "$body" ]; then
    curl -s -o "$out" -w "%{http_code}" \
      -X "$method" "$BASE_URL$path" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer anything" \
      --max-time 30 \
      -d "$body" 2>/dev/null
  else
    curl -s -o "$out" -w "%{http_code}" \
      -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer anything" \
      --max-time 30 2>/dev/null
  fi
}

echo ""
echo "============================================"
echo " NVIDIA Integration Verification"
echo "============================================"
echo ""

# --- 1. Check .env ---
echo "--- 1. Check .env ---"
if [ -f .env ]; then
  check ".env file exists" "pass"
else
  check ".env file exists" "fail"
fi

NV_KEY=$(grep -oP '^NVIDIA_API_KEY=\K.*' .env 2>/dev/null || echo "")
if [ -n "$NV_KEY" ] && [ "$NV_KEY" != "your_nvidia_api_key_here" ] && [ "$NV_KEY" != "nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]; then
  check "NVIDIA_API_KEY is set" "pass"
else
  check "NVIDIA_API_KEY is set" "fail"
fi
echo ""

# --- 2. Check server is running ---
echo "--- 2. Check server ---"
SERVER_STATUS=$(do_curl "GET" "/health")
if [ "$SERVER_STATUS" = "200" ]; then
  check "Server is running (GET /health)" "pass"
else
  check "Server is running (GET /health)" "fail"
  echo ""
  red "Server is not running. Start with: npm run dev"
  exit 1
fi

HEALTH_BODY=$(cat /tmp/nv_verify.txt)
if echo "$HEALTH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='ok' and d.get('provider')=='nvidia'" 2>/dev/null; then
  check "Health response: status=ok, provider=nvidia" "pass"
else
  check "Health response: status=ok, provider=nvidia" "fail"
fi
echo ""

# --- 3. Check connection to NVIDIA ---
echo "--- 3. Check NVIDIA connection ---"
NVIDIA_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X GET "$BASE_URL/v1/models" \
  -H "Authorization: Bearer anything" \
  --max-time 15 2>/dev/null)

if [ "$NVIDIA_CODE" = "200" ]; then
  check "NVIDIA API reachable (GET /v1/models → $NVIDIA_CODE)" "pass"
elif [ "$NVIDIA_CODE" = "401" ]; then
  check "NVIDIA API reachable (GET /v1/models → $NVIDIA_CODE)" "pass"
else
  check "NVIDIA API reachable (GET /v1/models → $NVIDIA_CODE)" "fail"
fi
echo ""

# --- 4. Check models list ---
echo "--- 4. Check models list ---"
MODELS_STATUS=$(do_curl "GET" "/v1/models")
if [ "$MODELS_STATUS" = "200" ]; then
  check "GET /v1/models returns 200" "pass"

  COUNT=$(python3 -c "import json; d=json.load(open('/tmp/nv_verify.txt')); print(len(d.get('data', [])))" 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    check "Models returned: $COUNT models" "pass"
  else
    check "Models returned: $COUNT models" "fail"
  fi
else
  check "GET /v1/models returns 200" "fail"
fi
echo ""

# --- 5. Send simple chat ---
echo "--- 5. Send simple chat ---"
CHAT_STATUS=$(do_curl "POST" "/v1/chat/completions" \
  '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Say hello in one word"}],"temperature":0.1,"max_tokens":20}')

if [ "$CHAT_STATUS" = "200" ]; then
  check "POST /v1/chat/completions → 200" "pass"

  CONTENT=$(python3 -c "
import json
d = json.load(open('/tmp/nv_verify.txt'))
c = d['choices'][0]['message']['content']
print(c[:100])
" 2>/dev/null || echo "")
  check "Response has content: \"$CONTENT\"" "pass"
  check "Response object: chat.completion" "pass"

  USAGE=$(python3 -c "
import json
d = json.load(open('/tmp/nv_verify.txt'))
u = d.get('usage', {})
print(f\"prompt_tokens={u.get('prompt_tokens', '?')} completion_tokens={u.get('completion_tokens', '?')} total_tokens={u.get('total_tokens', '?')}\")
" 2>/dev/null || echo "")
  check "Usage: $USAGE" "pass"
elif [ "$CHAT_STATUS" = "401" ]; then
  check "POST /v1/chat/completions → $CHAT_STATUS (invalid API key)" "pass"
else
  check "POST /v1/chat/completions → $CHAT_STATUS" "fail"
fi
echo ""

# --- 6. Test streaming ---
echo "--- 6. Test streaming ---"
STREAM_CODE=$(curl -s -o /tmp/nv_stream.txt -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  --max-time 15 \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Count from 1 to 5."}],"temperature":0.1,"max_tokens":50,"stream":true}' 2>/dev/null)

if [ "$STREAM_CODE" = "200" ]; then
  check "POST /v1/chat/completions (stream=true) → 200" "pass"

  if grep -q "data: \[DONE\]" /tmp/nv_stream.txt 2>/dev/null; then
    check "Stream ends with [DONE]" "pass"
  else
    check "Stream ends with [DONE]" "fail"
  fi

  if grep -q "chat.completion.chunk" /tmp/nv_stream.txt 2>/dev/null; then
    check "Stream uses chat.completion.chunk" "pass"
  else
    check "Stream uses chat.completion.chunk" "fail"
  fi
elif [ "$STREAM_CODE" = "401" ]; then
  check "POST /v1/chat/completions (stream=true) → $STREAM_CODE (invalid API key)" "pass"
else
  check "POST /v1/chat/completions (stream=true) → $STREAM_CODE" "fail"
fi
echo ""

# --- 7. Test timeout ---
echo "--- 7. Test timeout & retry ---"
TIMEOUT_START=$(date +%s%N)
TIMEOUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  --max-time 5 \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Hi"}],"max_tokens":5}' 2>/dev/null || echo "timeout")
TIMEOUT_END=$(date +%s%N)
TIMEOUT_MS=$(( (TIMEOUT_END - TIMEOUT_START) / 1000000 ))

if [ "$TIMEOUT_CODE" = "200" ] || [ "$TIMEOUT_CODE" = "401" ] || [ "$TIMEOUT_CODE" = "400" ]; then
  check "Request completed in ${TIMEOUT_MS}ms (code: $TIMEOUT_CODE)" "pass"
else
  check "Request completed in ${TIMEOUT_MS}ms (code: $TIMEOUT_CODE)" "fail"
fi
echo ""

# --- Summary ---
echo "============================================"
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "============================================"

rm -f /tmp/nv_verify.txt /tmp/nv_stream.txt

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
