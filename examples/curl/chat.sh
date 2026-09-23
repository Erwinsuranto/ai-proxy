#!/usr/bin/env bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{
    "model": "meta/llama-3.3-70b-instruct",
    "messages": [{"role": "user", "content": "Hello! What is the weather like today?"}],
    "temperature": 0.7,
    "max_tokens": 100
  }' | jq .
