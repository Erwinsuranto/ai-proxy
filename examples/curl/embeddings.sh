#!/usr/bin/env bash
curl -s http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{
    "model": "nvidia/nv-embedqa-e5-v5",
    "input": "Hello world, this is a test."
  }' | jq .
