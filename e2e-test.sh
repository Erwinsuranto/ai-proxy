#!/bin/bash
set -e

echo "=== Building project ==="
cd /root/api-proxy
npm run build 2>&1

echo ""
echo "=== Starting server ==="
# Kill any existing server
kill -9 $(pgrep -f "node dist/server") 2>/dev/null || true
sleep 1

# Start server in background with nohup
nohup node dist/server.js > /tmp/proxy-server.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server to be ready
for i in $(seq 1 30); do
  sleep 2
  if curl -s -m 3 http://localhost:3000/health 2>/dev/null | grep -q ok; then
    echo "Server ready after ${i}s"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Server failed to start"
    tail -30 /tmp/proxy-server.log
    exit 1
  fi
  echo "Waiting... ($i)"
done

echo ""
echo "=== Test 1: NVIDIA model (nvidia/meta/llama-3.1-8b-instruct) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"nvidia/meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 2: deepseek-ai/deepseek-v4-flash (should fallback from OpenRouter to NVIDIA) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"deepseek-ai/deepseek-v4-flash","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 3: glm-* (via OpenRouter) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 4: step-3.7-flash (StepFun) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"step-3.7-flash","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 5: cohere/*:free (OpenRouter) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"cohere/north-mini-code:free","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 6: @cf/* (Cloudflare) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 7: gpt-oss-20b (Cloudflare) ==="
RESP=$(curl -s -m 60 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"gpt-oss-20b","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":20,"stream":false}')
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'choices' in d:
    c = d['choices'][0]['message'].get('content')
    print('  PASS - Content:', (c or '(null)')[:100])
elif 'error' in d:
    print('  FAIL -', d['error'].get('message','?')[:200])
else:
    print('  UNKNOWN:', str(d)[:300])
"

echo ""
echo "=== Test 8: Streaming (NVIDIA model) ==="
RESP=$(curl -s -m 30 -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"nvidia/meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Count 1-3"}],"max_tokens":30,"stream":true}')
echo "$RESP" | python3 -c "
import sys
raw = sys.stdin.read()
lines = [l for l in raw.split('\n') if l.startswith('data: ') and l != 'data: [DONE]']
if lines:
    import json
    d = json.loads(lines[0][6:])
    if 'choices' in d:
        print('  PASS - SSE streaming works,', len(lines), 'chunks')
    else:
        print('  FAIL - unexpected format:', str(d)[:200])
else:
    print('  FAIL - no SSE data chunks found')
    print('  Raw:', raw[:300])
"

echo ""
echo "=== Summary ==="
echo "Tests completed. See /tmp/proxy-server.log for routing logs"
tail -20 /tmp/proxy-server.log

# Cleanup
kill $SERVER_PID 2>/dev/null || true
