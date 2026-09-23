#!/usr/bin/env bash
#===============================================================================
# NVIDIA API Proxy - curl Examples for All Endpoints
#
# Start the proxy first:
#   npm run dev   # or: docker compose up -d
#
# Usage:
#   bash examples/curl/all.sh          # runs all examples
#   bash examples/curl/all.sh health   # runs a single section
#===============================================================================
set -euo pipefail

BASE="http://localhost:3000"
AUTH="Authorization: Bearer nvidia-api-proxy"

# ---------- helper ----------
section() {
  echo ""
  echo "=============================================="
  echo "  $*"
  echo "=============================================="
}

# ---------- health ----------
do_health() {
  section "GET /health"
  curl -s "$BASE/health" | jq .
}

# ---------- models ----------
do_models() {
  section "GET /v1/models"
  curl -s "$BASE/v1/models" \
    -H "$AUTH" | jq '.data[:5]'
}

# ---------- chat (non-streaming) ----------
do_chat() {
  section "POST /v1/chat/completions (non-streaming)"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "model": "meta/llama-3.1-8b-instruct",
      "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain what NVIDIA API Proxy does in one sentence."}
      ],
      "temperature": 0.7,
      "max_tokens": 200
    }' | jq '{response: .choices[0].message.content, usage: .usage}'
}

# ---------- chat (streaming) ----------
do_chat_stream() {
  section "POST /v1/chat/completions (streaming)"
  curl -s --no-buffer "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "model": "meta/llama-3.1-8b-instruct",
      "messages": [{"role": "user", "content": "Count from 1 to 5."}],
      "stream": true
    }'
  echo ""
}

# ---------- embeddings ----------
do_embeddings() {
  section "POST /v1/embeddings"
  curl -s "$BASE/v1/embeddings" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "model": "nvidia/nv-embedqa-e5-v5",
      "input": "Hello world, this is a test embedding request."
    }' | jq '{dimension: (.data[0].embedding | length), usage: .usage}'
}

# ---------- responses API ----------
do_responses() {
  section "POST /v1/responses (non-streaming)"
  curl -s "$BASE/v1/responses" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "model": "meta/llama-3.1-8b-instruct",
      "input": "Explain what NVIDIA API Proxy does in one sentence.",
      "temperature": 0.7,
      "max_output_tokens": 200
    }' | jq '{id, object, status, output: [.output[0].content[0].text], usage}'
}

# ---------- internal /health ----------
do_internal_health() {
  section "GET /internal/health"
  curl -s "$BASE/internal/health" | jq .
}

# ---------- internal /keys ----------
do_internal_keys() {
  section "GET /internal/keys"
  curl -s "$BASE/internal/keys" | jq .
}

# ---------- main ----------
main() {
  if [ $# -gt 0 ]; then
    case "$1" in
      health)        do_health ;;
      models)        do_models ;;
      chat)          do_chat ;;
      stream)        do_chat_stream ;;
      embeddings)    do_embeddings ;;
      responses)     do_responses ;;
      internal)      do_internal_health; do_internal_keys ;;
      *)             echo "Unknown section: $1"; exit 1 ;;
    esac
  else
    do_health
    do_models
    do_chat
    do_chat_stream
    do_embeddings
    do_responses
    do_internal_health
    do_internal_keys
  fi
}

main "$@"
