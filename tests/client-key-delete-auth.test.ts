/* Client API Keys — DELETE lifecycle through the ADMIN UI's real request
 * shape, verified against a NON-PERMISSIVE master key so the security
 * behaviour is genuinely observable:
 *
 *   create (raw key returned EXACTLY once)   → key authenticates on /v1
 *   DELETE, body-less, no Content-Type       → 200 (this is what api() now
 *                                              sends after the fix; with
 *                                              Content-Type on a body-less
 *                                              request Fastify 400s — see
 *                                              client-api-keys.test.ts)
 *   deleted raw key                           → 401, request never routed
 *   other client keys + master                → untouched, still 200
 *   repeated DELETE                           → 404 (existing contract)
 *   raw key                                   → never present in any GET /
 *                                                list response
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { startServer, stopServer, getBaseUrl, configFile } from './setup';

const MASTER = 'e2e-master-secret-ck';
const EMP_MODEL = 'emp-ck-auth-model';
const CLIENT_KEYS_FILE = configFile('client-api-keys.json');

const upstreamAuths: string[] = [];
const MOCK = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    upstreamAuths.push(String(req.headers['authorization'] || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-ck', object: 'chat.completion', created: 1, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }));
    return;
  }
  res.writeHead(404); res.end();
});

let mockPort = 0;

/** HTTP call mirroring EXACTLY how the fixed admin client sends requests:
 *  Authorization always; Content-Type ONLY when a body is present. */
function call(method: string, path: string, bearer: string, body?: unknown):
  Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, getBaseUrl());
    const headers: http.OutgoingHttpHeaders = { 'Authorization': `Bearer ${bearer}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: any = data;
          try { parsed = JSON.parse(data); } catch { /* raw text */ }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function chatWith(bearer: string) {
  return call('POST', '/v1/chat/completions', bearer, {
    model: EMP_MODEL, messages: [{ role: 'user', content: 'hi' }],
  });
}

let killedId = '';
let killedRaw = '';
let keptId = '';
let keptRaw = '';

beforeAll(async () => {
  await new Promise<void>(resolve => MOCK.listen(0, '127.0.0.1', resolve));
  mockPort = (MOCK.address() as any).port;
  await startServer({
    API_KEY: MASTER,
    EMPERO_API_KEY: 'empero-upstream-key',
    EMPERO_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await call('POST', '/admin/models', MASTER, { model: EMP_MODEL, providerId: 'empero', priority: 10 });
}, 30000);

afterAll(async () => {
  await stopServer().catch(() => { });
  MOCK.close();
  if (fs.existsSync(CLIENT_KEYS_FILE)) fs.unlinkSync(CLIENT_KEYS_FILE);
});

describe('Client key create → use → delete (UI request shape, non-permissive)', () => {
  it('creates two keys; raw values returned exactly once', async () => {
    const a = await call('POST', '/admin/client-keys', MASTER, { providerId: 'empero', allowedModels: [EMP_MODEL], label: 'to-delete' });
    expect(a.status).toBe(201);
    killedId = a.data.key.id; killedRaw = a.data.apiKey;
    const b = await call('POST', '/admin/client-keys', MASTER, { providerId: 'empero', allowedModels: [EMP_MODEL], label: 'keep-me' });
    expect(b.status).toBe(201);
    keptId = b.data.key.id; keptRaw = b.data.apiKey;
    expect(killedRaw.startsWith('sk-')).toBe(true);
  });

  it('raw key NEVER appears in any admin GET/list response — masked metadata only', async () => {
    const list = await call('GET', '/admin/client-keys', MASTER);
    expect(list.status).toBe(200);
    const dump = JSON.stringify(list.data);
    expect(dump).not.toContain(killedRaw);
    expect(dump).not.toContain(keptRaw);
    expect(dump).toContain('***');
  });

  it('the created key authenticates successfully before deletion', async () => {
    const res = await chatWith(killedRaw);
    expect(res.status).toBe(200);
  });

  it('DELETE (body-less, NO Content-Type — admin UI shape) removes the key; others survive', async () => {
    const del = await call('DELETE', `/admin/client-keys/${encodeURIComponent(killedId)}`, MASTER);
    expect(del.status).toBe(200);
    expect(del.data.status).toBe('ok');

    const list = await call('GET', '/admin/client-keys', MASTER);
    expect(list.data.keys.some((k: any) => k.id === killedId)).toBe(false);
    expect(list.data.keys.some((k: any) => k.id === keptId)).toBe(true);
    const file = fs.readFileSync(CLIENT_KEYS_FILE, 'utf-8');
    expect(file).not.toContain(killedId);
    expect(file).toContain(keptId);
  });

  it('the deleted raw key gets 401 and is NEVER forwarded upstream', async () => {
    const before = upstreamAuths.length;
    const res = await chatWith(killedRaw);
    expect(res.status).toBe(401);
    expect(upstreamAuths.length).toBe(before);
  });

  it('the surviving key and the master key still work (no collateral effect)', async () => {
    expect((await chatWith(keptRaw)).status).toBe(200);
    expect((await chatWith(MASTER)).status).toBe(200);
  });

  it('repeated DELETE of the vanished key → 404 with error (existing contract)', async () => {
    const again = await call('DELETE', `/admin/client-keys/${encodeURIComponent(killedId)}`, MASTER);
    expect(again.status).toBe(404);
    expect(String(again.data.error)).toContain(killedId);
  });
});
