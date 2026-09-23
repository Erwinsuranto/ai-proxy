#!/bin/bash
set -e

NVIDIA_KEY="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"
NVIDIA_URL="https://integrate.api.nvidia.com/v1/chat/completions"
PROXY_URL="http://127.0.0.1:3000/v1/chat/completions"
MODEL="meta/llama-3.1-8b-instruct"

REQ_BODY='{
  "model": "meta/llama-3.1-8b-instruct",
  "messages": [
    {"role": "system", "content": "You MUST use the get_current_time tool to answer."},
    {"role": "user", "content": "What time is it?"}
  ],
  "tools": [{"type":"function","function":{"name":"get_current_time","description":"Get the current time","parameters":{"type":"object","properties":{"format":{"type":"string","enum":["iso","12h","24h"]}},"required":[]}}}],
  "tool_choice": "auto",
  "temperature": 0.01,
  "max_tokens": 500
}'

STREAM_BODY=$(echo "$REQ_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); d['stream']=True; json.dump(d, sys.stdout)")

OUTDIR="/tmp/capture"
mkdir -p "$OUTDIR"

echo "============================================================"
echo "AUDIT TOOL CALLING: Tahap 4 - Capture Raw HTTP"
echo "============================================================"

# === TEST 1: Non-streaming DIRECT ===
echo ""
echo "--- TEST 1: Non-streaming DIRECT to NVIDIA ---"
echo "$REQ_BODY" > "$OUTDIR/req_direct_nostream.json"

HTTP_CODE=$(curl -s -o "$OUTDIR/resp_direct_nostream.json" -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NVIDIA_KEY}" \
  -d "$REQ_BODY" \
  "${NVIDIA_URL}" 2>"$OUTDIR/curl_direct_nostream.log")

echo "HTTP Status: $HTTP_CODE"
python3 -c "
import json
with open('$OUTDIR/resp_direct_nostream.json') as f:
    d = json.load(f)
print(json.dumps(d, indent=2))
" 2>&1

if [ "$HTTP_CODE" != "200" ]; then
    echo "ERROR: Direct API returned $HTTP_CODE. Tunggu rate limit."
    exit 1
fi

# === TEST 2: Non-streaming PROXY ===
echo ""
echo "--- TEST 2: Non-streaming via PROXY ---"
echo "$REQ_BODY" > "$OUTDIR/req_proxy_nostream.json"

HTTP_CODE=$(curl -s -o "$OUTDIR/resp_proxy_nostream.json" -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$REQ_BODY" \
  "${PROXY_URL}" 2>"$OUTDIR/curl_proxy_nostream.log")

echo "HTTP Status: $HTTP_CODE"

python3 -c "
import json
with open('$OUTDIR/resp_proxy_nostream.json') as f:
    d = json.load(f)
print(json.dumps(d, indent=2))
" 2>&1

# === TEST 3: Streaming DIRECT ===
echo ""
echo "--- TEST 3: Streaming DIRECT to NVIDIA ---"
echo "$STREAM_BODY" > "$OUTDIR/req_direct_stream.json"

curl -s -N -o "$OUTDIR/resp_direct_stream.txt" -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NVIDIA_KEY}" \
  -d "$STREAM_BODY" \
  "${NVIDIA_URL}" 2>"$OUTDIR/curl_direct_stream.log"

echo "Raw size: $(wc -c < $OUTDIR/resp_direct_stream.txt) bytes"
python3 -c "
with open('$OUTDIR/resp_direct_stream.txt') as f:
    data = f.read()
for i, line in enumerate(data.strip().split('\n')):
    if line.startswith('data: ') and line[6:] != '[DONE]':
        d = json.loads(line[6:])
        delta = d.get('choices',[{}])[0].get('delta',{})
        finish = d.get('choices',[{}])[0].get('finish_reason')
        tc = delta.get('tool_calls')
        print(f'  chunk[{i}]: finish={finish} has_tc={\"YES\" if tc else \"no\"} tc={json.dumps(tc) if tc else \"-\"}')
    elif line.startswith('data: ') and line[6:] == '[DONE]':
        print(f'  chunk[{i}]: [DONE]')
    else:
        print(f'  chunk[{i}]: {line[:80]}')
" 2>&1

# === TEST 4: Streaming PROXY ===
echo ""
echo "--- TEST 4: Streaming via PROXY ---"
echo "$STREAM_BODY" > "$OUTDIR/req_proxy_stream.json"

curl -s -N -o "$OUTDIR/resp_proxy_stream.txt" -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$STREAM_BODY" \
  "${PROXY_URL}" 2>"$OUTDIR/curl_proxy_stream.log"

echo "Raw size: $(wc -c < $OUTDIR/resp_proxy_stream.txt) bytes"
python3 -c "
with open('$OUTDIR/resp_proxy_stream.txt') as f:
    data = f.read()
for i, line in enumerate(data.strip().split('\n')):
    if line.startswith('data: ') and line[6:] != '[DONE]':
        d = json.loads(line[6:])
        delta = d.get('choices',[{}])[0].get('delta',{})
        finish = d.get('choices',[{}])[0].get('finish_reason')
        tc = delta.get('tool_calls')
        print(f'  chunk[{i}]: finish={finish} has_tc={\"YES\" if tc else \"no\"} tc={json.dumps(tc) if tc else \"-\"}')
    elif line.startswith('data: ') and line[6:] == '[DONE]':
        print(f'  chunk[{i}]: [DONE]')
    else:
        print(f'  chunk[{i}]: {line[:80]}')
" 2>&1

echo ""
echo "============================================================"
echo "COMPARISON: Non-streaming"
echo "============================================================"
python3 << 'PYEOF'
import json

with open('/tmp/capture/resp_direct_nostream.json') as f:
    direct = json.load(f)
with open('/tmp/capture/resp_proxy_nostream.json') as f:
    proxy = json.load(f)

def compare_fields(d, p, path=""):
    diffs = []
    all_keys = set(list(d.keys()) + list(p.keys()))
    for k in sorted(all_keys):
        cur = f"{path}.{k}" if path else k
        if k not in d:
            diffs.append((cur, "MISSING_IN_DIRECT", None, p[k]))
        elif k not in p:
            diffs.append((cur, "MISSING_IN_PROXY", d[k], None))
        elif k == 'id':
            diffs.append((cur, "TRANSIENT (diff id per request)", d[k], p[k]))
        elif isinstance(d[k], dict) and isinstance(p[k], dict):
            diffs.extend(compare_fields(d[k], p[k], cur))
        elif isinstance(d[k], list) and isinstance(p[k], list):
            for i in range(max(len(d[k]), len(p[k]))):
                ci = f"{cur}[{i}]"
                if i >= len(d[k]):
                    diffs.append((ci, "MISSING_IN_DIRECT", None, p[k][i]))
                elif i >= len(p[k]):
                    diffs.append((ci, "MISSING_IN_PROXY", d[k][i], None))
                elif isinstance(d[k][i], dict) and isinstance(p[k][i], dict):
                    diffs.extend(compare_fields(d[k][i], p[k][i], ci))
                else:
                    if d[k][i] != p[k][i]:
                        diffs.append((ci, "DIFFER", d[k][i], p[k][i]))
        else:
            if d[k] != p[k]:
                # Special case: tool call IDs are transient
                if k == 'id' and 'tool_calls' in path:
                    diffs.append((cur, "TRANSIENT (tool call id)", d[k], p[k]))
                else:
                    diffs.append((cur, "DIFFER", d[k], p[k]))
    return diffs

diffs = compare_fields(direct, proxy)
if diffs:
    print("Perbedaan ditemukan:")
    print(f"{'FIELD':<50} {'TYPE':<25} {'DIRECT':<40} {'PROXY':<40}")
    print("-"*155)
    for field, typ, dv, pv in diffs:
        print(f"{field:<50} {typ:<25} {str(dv)[:38]:<40} {str(pv)[:38]:<40}")
else:
    print("✓ SEMUA FIELD IDENTIK")

# Tool-call specific check
print("\nTool-call specific check:")
for label, data in [("DIRECT", direct), ("PROXY", proxy)]:
    choices = data.get('choices', [])
    for i, c in enumerate(choices):
        msg = c.get('message', {})
        tc = msg.get('tool_calls')
        fc = msg.get('function_call')
        finish = c.get('finish_reason')
        content = msg.get('content')
        role = msg.get('role')
        print(f"  {label} choice[{i}]:")
        print(f"    finish_reason: {finish}")
        print(f"    role: {role}")
        print(f"    content: {json.dumps(content)}")
        if tc:
            for j, t in enumerate(tc):
                print(f"    tool_calls[{j}]:")
                print(f"      id: {t.get('id')}")
                print(f"      type: {t.get('type')}")
                print(f"      function.name: {t.get('function',{}).get('name')}")
                print(f"      function.arguments: {t.get('function',{}).get('arguments')}")
        else:
            print(f"    tool_calls: None")

print("\n")
PYEOF

echo "============================================================"
echo "COMPARISON: Streaming"
echo "============================================================"
python3 << 'PYEOF'
import json

with open('/tmp/capture/resp_direct_stream.txt') as f:
    dlines = [l for l in f.read().split('\n') if l.startswith('data: ') and l[6:] != '[DONE]']
with open('/tmp/capture/resp_proxy_stream.txt') as f:
    plines = [l for l in f.read().split('\n') if l.startswith('data: ') and l[6:] != '[DONE]']

print(f"Chunks: DIRECT={len(dlines)} PROXY={len(plines)} {'✓' if len(dlines)==len(plines) else '✗'}")

maxc = max(len(dlines), len(plines))
for i in range(maxc):
    dl = dlines[i] if i < len(dlines) else None
    pl = plines[i] if i < len(plines) else None
    print(f"\n  chunk[{i}]:")
    for label, line in [("DIRECT", dl), ("PROXY", pl)]:
        if line:
            d = json.loads(line[6:])
            delta = d.get('choices',[{}])[0].get('delta',{})
            finish = d.get('choices',[{}])[0].get('finish_reason')
            tc = delta.get('tool_calls')
            content = delta.get('content')
            role = delta.get('role')
            print(f"    {label}: finish={finish} role={role} content={json.dumps(content)}")
            if tc:
                for j, t in enumerate(tc):
                    print(f"      tool_calls[{j}]: id={t.get('id')} type={t.get('type')} fn_name={t.get('function',{}).get('name')} args={t.get('function',{}).get('arguments')}")
        else:
            print(f"    {label}: MISSING")

print("\n")
PYEOF

echo "============================================================"
echo "RAW BYTE COMPARISON"
echo "============================================================"
echo "Non-streaming response diff (only structural):"
python3 << 'PYEOF'
import json

with open('/tmp/capture/resp_direct_nostream.json') as f:
    d = json.load(f)
with open('/tmp/capture/resp_proxy_nostream.json') as f:
    p = json.load(f)

# Strip transient fields (id, created, etc.)
def strip_transient(obj):
    if isinstance(obj, dict):
        return {k: strip_transient(v) for k, v in obj.items() 
                if k not in ('id', 'created', 'nvext', 'system_fingerprint', 'cached_tokens')}
    elif isinstance(obj, list):
        return [strip_transient(v) for v in obj]
    return obj

ds = strip_transient(d)
ps = strip_transient(p)

if ds == ps:
    print("✓ After stripping transient fields: IDENTICAL")
else:
    print("✗ Still differ after stripping transients")
    print("DIRECT:", json.dumps(ds, indent=2))
    print("PROXY:", json.dumps(ps, indent=2))

# Compare usage
print("\nUsage comparison:")
print(f"  DIRECT: {json.dumps(d.get('usage'))}")
print(f"  PROXY:  {json.dumps(p.get('usage'))}")
PYEOF

echo ""
echo "============================================================"
echo "AUDIT COMPLETE - Files in /tmp/capture/"
echo "============================================================"
ls -la /tmp/capture/
