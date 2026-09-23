import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyDiscovery,
  detectWAF,
  runDiscovery,
  discoveryStore,
  openAIModelExtractor,
} from '../src/lib/discovery';

const jsonHeaders = { 'content-type': 'application/json' };
const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
const extractOpenAI = openAIModelExtractor('test');

function resp(status: number, headers: Record<string, string>, data: any) {
  return { provider: 'p', url: 'http://x/models', elapsedMs: 5, response: { status, headers, data }, extract: extractOpenAI };
}

const ALIYUN_BODY = '<!doctypehtml><meta name="aliyun_waf_aa"content="x"><script>initAliyunCaptcha()</script>';
const CLOUDFLARE_BODY = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl checking your browser</body></html>';
const CAPTCHA_BODY = '<html><body><div class="slider">Please verify you are human (captcha)</div></body></html>';

describe('detectWAF', () => {
  it('flags text/html content-type', () => {
    expect(detectWAF('text/html', '{}')).toBe(true);
  });
  it('flags aliyun keyword in html body', () => {
    expect(detectWAF(null, ALIYUN_BODY)).toBe(true);
  });
  it('does NOT flag a legitimate JSON body containing the word verify', () => {
    expect(detectWAF('application/json', '{"data":[{"id":"verify-model"}]}')).toBe(false);
  });
});

describe('classifyDiscovery — WAF / non-JSON 200 responses', () => {
  it('HTML page (200 text/html) => blocked_by_waf, not empty_model_list', () => {
    const o = classifyDiscovery(resp(200, htmlHeaders, '<html><body>hi</body></html>'));
    expect(o.status).toBe('blocked_by_waf');
    expect(o.blockedByWAF).toBe(true);
  });

  it('Aliyun WAF CAPTCHA page => blocked_by_waf', () => {
    const o = classifyDiscovery(resp(200, htmlHeaders, ALIYUN_BODY));
    expect(o.status).toBe('blocked_by_waf');
  });

  it('Cloudflare challenge page => blocked_by_waf', () => {
    const o = classifyDiscovery(resp(200, htmlHeaders, CLOUDFLARE_BODY));
    expect(o.status).toBe('blocked_by_waf');
  });

  it('CAPTCHA/slider page with no explicit content-type => blocked_by_waf', () => {
    const o = classifyDiscovery(resp(200, {}, CAPTCHA_BODY));
    expect(o.status).toBe('blocked_by_waf');
  });
});

describe('classifyDiscovery — JSON validation', () => {
  it('valid model list => healthy', () => {
    const o = classifyDiscovery(resp(200, jsonHeaders, { data: [{ id: 'a' }, { id: 'b' }] }));
    expect(o.status).toBe('healthy');
    expect(o.models.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('empty JSON list => empty_model_list (NOT healthy)', () => {
    const o = classifyDiscovery(resp(200, jsonHeaders, { data: [] }));
    expect(o.status).toBe('empty_model_list');
  });

  it('JSON not matching schema => invalid_response', () => {
    const o = classifyDiscovery(resp(200, jsonHeaders, { foo: 'bar' }));
    expect(o.status).toBe('invalid_response');
  });

  it('non-JSON string body (json content-type) => invalid_json', () => {
    const o = classifyDiscovery(resp(200, jsonHeaders, 'this is not json {'));
    expect(o.status).toBe('invalid_json');
  });

  it('string body that IS json is parsed => healthy', () => {
    const o = classifyDiscovery(resp(200, jsonHeaders, '{"data":[{"id":"x"}]}'));
    expect(o.status).toBe('healthy');
    expect(o.models[0].id).toBe('x');
  });
});

describe('classifyDiscovery — error responses', () => {
  function errCase(status: number, extra: any = {}) {
    return classifyDiscovery({ provider: 'p', url: 'u', elapsedMs: 3, error: { status, response: { status, headers: jsonHeaders, data: { error: 'x' } }, ...extra }, extract: extractOpenAI });
  }
  it('HTTP 403 => authentication_failed', () => {
    expect(errCase(403).status).toBe('authentication_failed');
  });
  it('HTTP 429 => rate_limited', () => {
    expect(errCase(429).status).toBe('rate_limited');
  });
  it('HTTP 500 => upstream_error', () => {
    expect(errCase(500).status).toBe('upstream_error');
  });
  it('timeout (ECONNABORTED) => timeout', () => {
    const o = classifyDiscovery({ provider: 'p', url: 'u', elapsedMs: 3, error: { code: 'ECONNABORTED', message: 'timeout of 1000ms exceeded' }, extract: extractOpenAI });
    expect(o.status).toBe('timeout');
  });
  it('WAF page delivered via a 403 error body => blocked_by_waf', () => {
    const o = classifyDiscovery({ provider: 'p', url: 'u', elapsedMs: 3, error: { status: 403, response: { status: 403, headers: htmlHeaders, data: ALIYUN_BODY } }, extract: extractOpenAI });
    expect(o.status).toBe('blocked_by_waf');
  });
});

describe('runDiscovery — state + cache preservation', () => {
  beforeEach(() => discoveryStore.reset());

  it('records healthy state and caches the models', async () => {
    const r = await runDiscovery({
      provider: 'prov1',
      url: 'u',
      request: async () => ({ status: 200, headers: jsonHeaders, data: { data: [{ id: 'm1' }] } }),
      extract: extractOpenAI,
    });
    expect(r.outcome.status).toBe('healthy');
    expect(r.models.map((m) => m.id)).toEqual(['m1']);
    const state = discoveryStore.getState('prov1')!;
    expect(state.status).toBe('healthy');
    expect(state.modelsDiscovered).toBe(1);
    expect(state.lastSuccess).not.toBeNull();
  });

  it('preserves last-known-good models when a later discovery FAILS (WAF)', async () => {
    // 1. Successful discovery seeds the cache.
    await runDiscovery({
      provider: 'prov2',
      url: 'u',
      request: async () => ({ status: 200, headers: jsonHeaders, data: { data: [{ id: 'keep-me' }] } }),
      extract: extractOpenAI,
    });

    // 2. Next discovery returns a WAF page — cache must NOT be wiped.
    const r = await runDiscovery({
      provider: 'prov2',
      url: 'u',
      request: async () => ({ status: 200, headers: htmlHeaders, data: ALIYUN_BODY }),
      extract: extractOpenAI,
    });

    expect(r.outcome.status).toBe('blocked_by_waf');
    expect(r.fromCache).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(['keep-me']);
    const state = discoveryStore.getState('prov2')!;
    expect(state.status).toBe('blocked_by_waf');
    expect(state.blockedByWAF).toBe(true);
    expect(state.cachedModels).toBe(1); // registry not wiped
  });

  it('preserves cache when discovery throws (HTTP 500)', async () => {
    await runDiscovery({
      provider: 'prov3',
      url: 'u',
      request: async () => ({ status: 200, headers: jsonHeaders, data: { data: [{ id: 'cached' }] } }),
      extract: extractOpenAI,
    });
    const r = await runDiscovery({
      provider: 'prov3',
      url: 'u',
      request: async () => { throw { status: 500, response: { status: 500, headers: jsonHeaders, data: {} } }; },
      extract: extractOpenAI,
    });
    expect(r.outcome.status).toBe('upstream_error');
    expect(r.models.map((m) => m.id)).toEqual(['cached']);
  });

  it('applies WAF backoff — skips upstream on the immediate next call', async () => {
    let calls = 0;
    const req = async () => { calls++; return { status: 200, headers: htmlHeaders, data: ALIYUN_BODY }; };
    await runDiscovery({ provider: 'prov4', url: 'u', request: req, extract: extractOpenAI });
    expect(calls).toBe(1);
    // Second call should be skipped due to backoff (no new upstream hit).
    const r = await runDiscovery({ provider: 'prov4', url: 'u', request: req, extract: extractOpenAI });
    expect(calls).toBe(1);
    expect(r.skipped).toBe(true);
  });
});
