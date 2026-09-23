#!/usr/bin/env bash
set -e

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

check_status() {
  local desc="$1"
  local method="$2"
  local path="$3"
  local body="$4"
  local expected_status="${5:-200}"

  if [ -n "$body" ]; then
    status=$(curl -s -o /tmp/check_response.txt -w "%{http_code}" \
      -X "$method" "$BASE_URL$path" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer anything" \
      -d "$body")
  else
    status=$(curl -s -o /tmp/check_response.txt -w "%{http_code}" \
      -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer anything")
  fi

  if [ "$status" = "$expected_status" ]; then
    green "  ✓ PASS  ${desc}"
    PASS=$((PASS + 1))
    return 0
  else
    red "  ✗ FAIL  ${desc} (expected ${expected_status}, got ${status})"
    cat /tmp/check_response.txt | head -c 300
    echo ""
    FAIL=$((FAIL + 1))
    return 1
  fi
}

check_field() {
  local desc="$1"
  local json_path="$2"
  local file="${3:-/tmp/check_response.txt}"

  if python3 -c "
import sys, json
with open('$file') as f:
    d = json.load(f)
    keys = '${json_path}'.strip('.').split('.')
    for k in keys:
        if k.isdigit():
            d = d[int(k)]
        else:
            d = d.get(k, {})
        if d == {}:
            print(False)
            sys.exit(0)
    print(True)
" 2>/dev/null; then
    green "  ✓ PASS  ${desc}"
    PASS=$((PASS + 1))
  else
    red "  ✗ FAIL  ${desc} (field '${json_path}' not found)"
    FAIL=$((FAIL + 1))
  fi
}

check_error_field() {
  local desc="$1"
  local field="$2"
  local file="${3:-/tmp/check_response.txt}"

  if python3 -c "
import sys, json
with open('$file') as f:
    d = json.load(f)
    keys = 'error.${field}'.split('.')
    for k in keys:
        d = d[k]
    print(True)
" 2>/dev/null; then
    green "  ✓ PASS  ${desc}"
    PASS=$((PASS + 1))
  else
    red "  ✗ FAIL  ${desc} (error.${field} not found)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "==================================="
echo " NVIDIA API Proxy - Health Check"
echo "==================================="
echo " Base URL: $BASE_URL"
echo "==================================="
echo ""

# --- Server health ---
check_status "GET /health" GET "/health"

# --- Models endpoint ---
check_status "GET /v1/models" GET "/v1/models"
check_field "response.object" "object"

# --- Chat validation ---
check_status "POST /v1/chat/completions (no model)" POST "/v1/chat/completions" \
  '{"messages":[{"role":"user","content":"Hi"}]}' 400
check_error_field "error.message" "message"
check_error_field "error.type" "type"
check_error_field "error.code" "code"

check_status "POST /v1/chat/completions (no messages)" POST "/v1/chat/completions" \
  '{"model":"test"}' 400
check_error_field "error.message" "message"

# --- Chat completion ---
chat_status=$(curl -s -o /tmp/check_chat.txt -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Say hi in one word"}],"temperature":0.7,"max_tokens":50}')

if [ "$chat_status" = "200" ]; then
  green "  ✓ PASS  POST /v1/chat/completions"
  PASS=$((PASS + 1))
  check_field "response.id" "id" /tmp/check_chat.txt
  check_field "response.object == 'chat.completion'" "object" /tmp/check_chat.txt
  check_field "response.choices[0].message.content" "choices.0.message.content" /tmp/check_chat.txt
  check_field "response.choices[0].finish_reason" "choices.0.finish_reason" /tmp/check_chat.txt
  check_field "response.usage.total_tokens" "usage.total_tokens" /tmp/check_chat.txt
else
  red "  ✗ FAIL  POST /v1/chat/completions (got $chat_status)"
  FAIL=$((FAIL + 1))
  # Even on error, check OpenAI format
  cp /tmp/check_chat.txt /tmp/check_response.txt
  check_error_field "error.message" "message"
  check_error_field "error.type" "type"
  check_error_field "error.code" "code"
fi

# --- Streaming ---
echo ""
echo "--- Testing Streaming ---"
stream_status=$(curl -s -o /tmp/check_stream.txt -w "%{http_code}" \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  --max-time 15 \
  -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Count 1 to 3"}],"stream":true}')

if [ "$stream_status" = "200" ]; then
  green "  ✓ PASS  POST /v1/chat/completions (stream)"
  PASS=$((PASS + 1))
  if grep -q "data: \[DONE\]" /tmp/check_stream.txt; then
    green "  ✓ PASS  Streaming ends with [DONE]"
    PASS=$((PASS + 1))
  else
    red "  ✗ FAIL  Streaming missing [DONE]"
    FAIL=$((FAIL + 1))
  fi
  if grep -q "chat.completion.chunk" /tmp/check_stream.txt; then
    green "  ✓ PASS  Streaming uses chat.completion.chunk"
    PASS=$((PASS + 1))
  else
    red "  ✗ FAIL  Streaming missing chat.completion.chunk"
    FAIL=$((FAIL + 1))
  fi
else
  red "  ✗ FAIL  POST /v1/chat/completions (stream) (got $stream_status)"
  FAIL=$((FAIL + 1))
  # Check that the error response is OpenAI format
  if [ -s /tmp/check_stream.txt ]; then
    cp /tmp/check_stream.txt /tmp/check_response.txt
    check_error_field "error.message" "message"
    check_error_field "error.type" "type"
  fi
fi

# --- Embeddings validation ---
check_status "POST /v1/embeddings (no model)" POST "/v1/embeddings" \
  '{"input":"test"}' 400
check_error_field "error.message" "message"

# --- Embeddings ---
emb_status=$(curl -s -o /tmp/check_emb.txt -w "%{http_code}" \
  -X POST "$BASE_URL/v1/embeddings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{"model":"nvidia/nv-embedqa-e5-v5","input":"Hello world"}')

if [ "$emb_status" = "200" ]; then
  green "  ✓ PASS  POST /v1/embeddings"
  PASS=$((PASS + 1))
  check_field "response.object == 'list'" "object" /tmp/check_emb.txt
  check_field "response.data[0].embedding" "data.0.embedding" /tmp/check_emb.txt
  check_field "response.usage.total_tokens" "usage.total_tokens" /tmp/check_emb.txt
else
  red "  ✗ FAIL  POST /v1/embeddings (got $emb_status)"
  FAIL=$((FAIL + 1))
  cp /tmp/check_emb.txt /tmp/check_response.txt
  check_error_field "error.message" "message"
  check_error_field "error.type" "type"
fi

echo ""
echo "==================================="
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "==================================="

rm -f /tmp/check_response.txt /tmp/check_chat.txt /tmp/check_stream.txt /tmp/check_emb.txt

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
