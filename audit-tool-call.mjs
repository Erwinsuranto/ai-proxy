import http from 'http';
import https from 'https';

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_KEY = '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';
const PROXY = 'http://localhost:3000';
const MODEL = 'meta/llama-3.1-8b-instruct';

const TOOL_REQUEST = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You MUST use the get_current_time tool to answer the user. You have the tool available. Call it.' },
    { role: 'user', content: 'What time is it?' }
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current time',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['iso', '12h', '24h'],
            description: 'Time format'
          }
        },
        required: []
      }
    }
  }],
  tool_choice: 'auto',
  temperature: 0.01,
  max_tokens: 500
};

function httpRequest(url, method, headers, body, raw = false) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...headers },
    };
    
    if (raw) {
      let data = [];
      options.headers['Accept'] = 'text/event-stream';
    }
    
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
          raw: buf
        });
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function captureDirect(mode) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CAPTURE: Direct NVIDIA API - ${mode.toUpperCase()}`);
  console.log(`${'='.repeat(80)}`);
  
  const payload = { ...TOOL_REQUEST };
  if (mode === 'streaming') payload.stream = true;
  
  const resp = await httpRequest(
    `${NVIDIA_BASE}/chat/completions`,
    'POST',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NVIDIA_KEY}`,
    },
    payload
  );
  
  console.log(`Status: ${resp.statusCode}`);
  console.log(`Headers:`, JSON.stringify(resp.headers, null, 2));
  
  if (mode === 'streaming') {
    console.log('\n--- RAW STREAM ---');
    const lines = resp.body.split('\n').filter(l => l.trim());
    lines.forEach((line, i) => {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          console.log(`[${i}] data: [DONE]`);
        } else {
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta || {};
            const keys = Object.keys(delta);
            const hasTC = delta.tool_calls ? 'YES' : 'no';
            const finish = parsed.choices?.[0]?.finish_reason || null;
            console.log(`[${i}] finish_reason=${finish} delta_keys=[${keys}] tool_calls=${hasTC} content=${JSON.stringify(delta.content || '').slice(0,50)}`);
            if (delta.tool_calls) {
              console.log(`     tool_calls: ${JSON.stringify(delta.tool_calls)}`);
            }
          } catch(e) {
            console.log(`[${i}] PARSE ERROR: ${data.slice(0,100)}`);
          }
        }
      }
    });
  } else {
    try {
      const parsed = JSON.parse(resp.body);
      console.log('\n--- RESPONSE JSON ---');
      console.log(`id: ${parsed.id}`);
      console.log(`object: ${parsed.object}`);
      console.log(`model: ${parsed.model}`);
      console.log(`usage: ${JSON.stringify(parsed.usage)}`);
      
      if (parsed.choices) {
        parsed.choices.forEach((choice, i) => {
          console.log(`\nchoice[${i}]:`);
          console.log(`  index: ${choice.index}`);
          console.log(`  finish_reason: ${choice.finish_reason}`);
          console.log(`  message.role: ${choice.message?.role}`);
          console.log(`  message.content: ${choice.message?.content ? JSON.stringify(choice.message.content) : null}`);
          if (choice.message?.tool_calls) {
            console.log(`  message.tool_calls: ${JSON.stringify(choice.message.tool_calls, null, 4)}`);
          } else {
            console.log(`  message.tool_calls: undefined`);
          }
          if (choice.message?.function_call) {
            console.log(`  message.function_call: ${JSON.stringify(choice.message.function_call)}`);
          }
        });
      }
    } catch(e) {
      console.log(`PARSE ERROR: ${e.message}`);
      console.log(`RAW BODY: ${resp.body.slice(0, 500)}`);
    }
  }
  
  return resp;
}

async function captureProxy(mode) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CAPTURE: Through PROXY - ${mode.toUpperCase()}`);
  console.log(`${'='.repeat(80)}`);
  
  const payload = { ...TOOL_REQUEST };
  if (mode === 'streaming') payload.stream = true;
  
  const resp = await httpRequest(
    `${PROXY}/v1/chat/completions`,
    'POST',
    { 'Content-Type': 'application/json' },
    payload
  );
  
  console.log(`Status: ${resp.statusCode}`);
  console.log(`Headers:`, JSON.stringify(resp.headers, null, 2));
  
  if (mode === 'streaming') {
    console.log('\n--- RAW STREAM ---');
    const lines = resp.body.split('\n').filter(l => l.trim());
    lines.forEach((line, i) => {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          console.log(`[${i}] data: [DONE]`);
        } else {
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta || {};
            const keys = Object.keys(delta);
            const hasTC = delta.tool_calls ? 'YES' : 'no';
            const finish = parsed.choices?.[0]?.finish_reason || null;
            console.log(`[${i}] finish_reason=${finish} delta_keys=[${keys}] tool_calls=${hasTC} content=${JSON.stringify(delta.content || '').slice(0,50)}`);
            if (delta.tool_calls) {
              console.log(`     tool_calls: ${JSON.stringify(delta.tool_calls)}`);
            }
          } catch(e) {
            console.log(`[${i}] PARSE ERROR: ${data.slice(0,100)}`);
          }
        }
      }
    });
  } else {
    try {
      const parsed = JSON.parse(resp.body);
      console.log('\n--- RESPONSE JSON ---');
      console.log(`id: ${parsed.id}`);
      console.log(`object: ${parsed.object}`);
      console.log(`model: ${parsed.model}`);
      console.log(`usage: ${JSON.stringify(parsed.usage)}`);
      
      if (parsed.choices) {
        parsed.choices.forEach((choice, i) => {
          console.log(`\nchoice[${i}]:`);
          console.log(`  index: ${choice.index}`);
          console.log(`  finish_reason: ${choice.finish_reason}`);
          console.log(`  message.role: ${choice.message?.role}`);
          console.log(`  message.content: ${choice.message?.content ? JSON.stringify(choice.message.content) : null}`);
          if (choice.message?.tool_calls) {
            console.log(`  message.tool_calls: ${JSON.stringify(choice.message.tool_calls, null, 4)}`);
          } else {
            console.log(`  message.tool_calls: undefined`);
          }
          if (choice.message?.function_call) {
            console.log(`  message.function_call: ${JSON.stringify(choice.message.function_call)}`);
          }
        });
      }
    } catch(e) {
      console.log(`PARSE ERROR: ${e.message}`);
      console.log(`RAW BODY: ${resp.body.slice(0, 500)}`);
    }
  }
  
  return resp;
}

async function main() {
  // Test 1: Non-streaming - Direct
  const directNonStream = await captureDirect('non-streaming');
  
  // Test 2: Non-streaming - Proxy
  const proxyNonStream = await captureProxy('non-streaming');
  
  // Compare non-streaming
  console.log(`\n\n${'='.repeat(80)}`);
  console.log(`COMPARISON: NON-STREAMING`);
  console.log(`${'='.repeat(80)}`);
  
  try {
    const d = JSON.parse(directNonStream.body);
    const p = JSON.parse(proxyNonStream.body);
    
    const fields = ['id', 'object', 'model', 'usage', 'choices'];
    fields.forEach(f => {
      const dv = JSON.stringify(d[f]);
      const pv = JSON.stringify(p[f]);
      const match = dv === pv ? '✓ MATCH' : '✗ DIFFER';
      console.log(`  ${f}: ${match}`);
      if (dv !== pv) {
        console.log(`    DIRECT: ${dv.slice(0, 200)}`);
        console.log(`    PROXY:  ${pv.slice(0, 200)}`);
      }
    });
    
    // Detailed choice comparison
    if (d.choices && p.choices) {
      d.choices.forEach((dc, i) => {
        const pc = p.choices[i];
        if (!pc) return;
        console.log(`\n  choice[${i}] DETAIL:`);
        console.log(`    finish_reason: ${dc.finish_reason} === ${pc.finish_reason} ${dc.finish_reason === pc.finish_reason ? '✓' : '✗'}`);
        console.log(`    message.role: ${dc.message?.role} === ${pc.message?.role} ${dc.message?.role === pc.message?.role ? '✓' : '✗'}`);
        
        const dContent = JSON.stringify(dc.message?.content);
        const pContent = JSON.stringify(pc.message?.content);
        console.log(`    message.content: ${dContent === pContent ? '✓ MATCH' : '✗ DIFFER'}`);
        if (dContent !== pContent) {
          console.log(`      DIRECT: ${dContent.slice(0, 200)}`);
          console.log(`      PROXY:  ${pContent.slice(0, 200)}`);
        }
        
        const dTC = JSON.stringify(dc.message?.tool_calls);
        const pTC = JSON.stringify(pc.message?.tool_calls);
        console.log(`    message.tool_calls: ${dTC === pTC ? '✓ MATCH' : '✗ DIFFER'}`);
        if (dTC !== pTC) {
          console.log(`      DIRECT: ${dTC}`);
          console.log(`      PROXY:  ${pTC}`);
        }
      });
    }
  } catch(e) {
    console.log(`COMPARISON ERROR: ${e.message}`);
  }
  
  // Test 3: Streaming - Direct
  const directStream = await captureDirect('streaming');
  
  // Test 4: Streaming - Proxy
  const proxyStream = await captureProxy('streaming');
  
  console.log(`\n\n${'='.repeat(80)}`);
  console.log(`COMPARISON: STREAMING`);
  console.log(`${'='.repeat(80)}`);
  
  const directLines = directStream.body.split('\n').filter(l => l.startsWith('data: ') && l.slice(6) !== '[DONE]');
  const proxyLines = proxyStream.body.split('\n').filter(l => l.startsWith('data: ') && l.slice(6) !== '[DONE]');
  
  console.log(`  Chunk count: DIRECT=${directLines.length} PROXY=${proxyLines.length} ${directLines.length === proxyLines.length ? '✓' : '✗'}`);
  
  // Compare streaming chunks
  const maxChunks = Math.max(directLines.length, proxyLines.length);
  let diffs = 0;
  for (let i = 0; i < maxChunks; i++) {
    try {
      const dData = directLines[i] ? JSON.parse(directLines[i].slice(6)) : null;
      const pData = proxyLines[i] ? JSON.parse(proxyLines[i].slice(6)) : null;
      
      if (!dData || !pData) {
        console.log(`  chunk[${i}]: MISSING ${!dData ? 'DIRECT' : 'PROXY'}`);
        diffs++;
        continue;
      }
      
      const dDelta = dData.choices?.[0]?.delta || {};
      const pDelta = pData.choices?.[0]?.delta || {};
      
      const dTC = dDelta.tool_calls;
      const pTC = pDelta.tool_calls;
      
      if (JSON.stringify(dTC) !== JSON.stringify(pTC)) {
        console.log(`  chunk[${i}]: tool_calls DIFFER`);
        console.log(`    DIRECT: ${JSON.stringify(dTC)}`);
        console.log(`    PROXY:  ${JSON.stringify(pTC)}`);
        diffs++;
      }
      
      const dFinish = dData.choices?.[0]?.finish_reason;
      const pFinish = pData.choices?.[0]?.finish_reason;
      
      if (dFinish !== pFinish) {
        console.log(`  chunk[${i}]: finish_reason DIFFER`);
        console.log(`    DIRECT: ${dFinish}`);
        console.log(`    PROXY:  ${pFinish}`);
        diffs++;
      }
      
      const dContent = dDelta.content;
      const pContent = pDelta.content;
      
      if (JSON.stringify(dContent) !== JSON.stringify(pContent)) {
        console.log(`  chunk[${i}]: content DIFFER`);
        console.log(`    DIRECT: ${JSON.stringify(dContent).slice(0, 100)}`);
        console.log(`    PROXY:  ${JSON.stringify(pContent).slice(0, 100)}`);
        diffs++;
      }
    } catch(e) {
      console.log(`  chunk[${i}]: PARSE ERROR ${e.message}`);
      diffs++;
    }
  }
  
  if (diffs === 0) {
    console.log('  ✓ ALL STREAMING CHUNKS MATCH');
  } else {
    console.log(`  ${diffs} differences found`);
  }
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`AUDIT COMPLETE`);
  console.log(`${'='.repeat(80)}`);
}

main().catch(console.error);
