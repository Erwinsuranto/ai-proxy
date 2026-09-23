#!/usr/bin/env bash
curl -s http://localhost:3000/v1/models \
  -H "Authorization: Bearer anything" | jq '.data[:3]'
