/* ============================================================================
 * Multi-route provider generic foundation — serial unit/contract tests.
 * No network, no real credentials, no .env changes. Kie routes are used as
 * DATA through the generic resolver only (no provider-specific branches).
 * ========================================================================== */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProviderRoutes,
  getRoutesForProvider,
  getRoute,
  hasRoutes,
  setRouteEnabled,
  clearProviderRoutes,
  resolveRoute,
  resolveRouteUrl,
  buildRouteUrl,
  validateRoutePath,
  validateBaseUrl,
  validateRouteModel,
  isBlockedHostname,
  RouteValidationError,
  RouteResolutionError,
} from '../src/lib/provider-routes';
import { normalizeRouteProtocol, isRouteProtocol } from '../src/lib/route-protocol';
import { getProtocolDefinition, listProtocols } from '../src/lib/protocol-registry';
import { KIE_PROVIDER_ID, KIE_BASE_URL, KIE_ROUTES } from '../src/lib/kie-routes';
import { buildResponsesRequest, parseResponsesResponse, extractResponsesUsage, normalizeResponsesError } from '../src/lib/adapters/openai-responses';
import { openaiToAnthropic, anthropicToOpenAI, extractAnthropicUsage } from '../src/lib/adapters/anthropic-messages';
import {
  buildGeminiRequest,
  parseGeminiResponse,
  parseGeminiStreamChunk,
  extractGeminiUsage,
  normalizeGeminiError,
} from '../src/lib/adapters/gemini';
import { buildOpenAIChatRequest, extractOpenAIChatUsage } from '../src/lib/adapters/openai-chat';
import { KeyManager } from '../src/lib/key-manager';
import { toPublicCombo } from '../src/lib/combo-store';

beforeEach(() => {
  clearProviderRoutes();
});

describe('route path validation', () => {
  it('accepts valid relative paths including {model} placeholder', () => {
    expect(validateRoutePath('/codex/v1/responses')).toBe('/codex/v1/responses');
    expect(validateRoutePath('/gemini/v1/models/{model}:streamGenerateContent'))
      .toBe('/gemini/v1/models/{model}:streamGenerateContent');
    expect(validateRoutePath('/claude/v1/messages')).toBe('/claude/v1/messages');
  });

  it('rejects absolute URLs, schemes, traversal and bad placeholders', () => {
    expect(() => validateRoutePath('https://evil.example.com/api')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('//evil.example.com/api')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('file:///etc/passwd')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('/api/../secret')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('/api/v1/{evil}')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('/a/{model}/b/{model}')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('relative/path')).toThrow(RouteValidationError);
    expect(() => validateRoutePath('/white space')).toThrow(RouteValidationError);
  });
});

describe('SSRF protection', () => {
  it('blocks loopback, private, link-local and metadata hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.4.9', '172.31.255.1',
      '192.168.1.1', '169.254.169.254', '::1', '0.0.0.0', 'db.local', 'svc.internal']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
    expect(isBlockedHostname('api.kie.ai')).toBe(false);
  });

  it('validateBaseUrl rejects credentials, non-http(s) and blocked hosts', () => {
    expect(() => validateBaseUrl('https://user:pass@api.kie.ai')).toThrow(RouteValidationError);
    expect(() => validateBaseUrl('ftp://api.kie.ai/v1')).toThrow(RouteValidationError);
    expect(() => validateBaseUrl('http://127.0.0.1:3000/v1')).toThrow(RouteValidationError);
    expect(() => validateBaseUrl('not-a-url')).toThrow(RouteValidationError);
    expect(validateBaseUrl('https://api.kie.ai/')).toBe('https://api.kie.ai');
  });

  it('validateRouteModel rejects empty, traversal and fragment/query chars', () => {
    expect(() => validateRouteModel('')).toThrow(RouteResolutionError);
    expect(() => validateRouteModel('../secret')).toThrow(RouteResolutionError);
    expect(() => validateRouteModel('model?x=1')).toThrow(RouteResolutionError);
    expect(() => validateRouteModel('model#frag')).toThrow(RouteResolutionError);
  });
});

describe('provider with multiple routes', () => {
  it('registers three kie routes from data and reports hasRoutes', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(hasRoutes(KIE_PROVIDER_ID)).toBe(true);
    expect(getRoutesForProvider(KIE_PROVIDER_ID).map((r) => r.id).sort())
      .toEqual(['kie-claude', 'kie-codex', 'kie-gemini']);
    expect(hasRoutes('nvidia')).toBe(false);
  });

  it('resolves unknown provider without cross-provider fallback', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(() => resolveRoute('nope', 'gemini-3-8-flash'))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_HAS_NO_ROUTES' }));
  });
});

describe('model -> route resolution', () => {
  it('routes gemini models to kie-gemini', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(resolveRoute(KIE_PROVIDER_ID, 'gemini-3-8-flash').route.id).toBe('kie-gemini');
    expect(resolveRoute(KIE_PROVIDER_ID, 'GEMINI-2.5-pro').route.id).toBe('kie-gemini');
  });

  it('routes claude models to kie-claude', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(resolveRoute(KIE_PROVIDER_ID, 'claude-opus-5').route.id).toBe('kie-claude');
  });

  it('routes codex models to kie-codex', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(resolveRoute(KIE_PROVIDER_ID, 'gpt-5-5').route.id).toBe('kie-codex');
    expect(resolveRoute(KIE_PROVIDER_ID, 'gpt-5.1-codex').route.id).toBe('kie-codex');
  });

  it('exact model match beats prefix and fails clearly with no match', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(() => resolveRoute(KIE_PROVIDER_ID, 'llama-3-3-70b'))
      .toThrowError(expect.objectContaining({ code: 'NO_MATCHING_ROUTE' }));
  });

  it('disabled route is never selected; all-disabled fails closed', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(setRouteEnabled(KIE_PROVIDER_ID, 'kie-gemini', false)).toBe(true);
    expect(getRoute(KIE_PROVIDER_ID, 'kie-gemini')?.enabled).toBe(false);
    expect(() => resolveRoute(KIE_PROVIDER_ID, 'gemini-3-8-flash'))
      .toThrowError(expect.objectContaining({ code: 'NO_MATCHING_ROUTE' }));
    setRouteEnabled(KIE_PROVIDER_ID, 'kie-claude', false);
    setRouteEnabled(KIE_PROVIDER_ID, 'kie-codex', false);
    expect(() => resolveRoute(KIE_PROVIDER_ID, 'gpt-5-5'))
      .toThrowError(expect.objectContaining({ code: 'ROUTE_DISABLED' }));
  });
});

describe('kie route URLs (generic baseUrl + path)', () => {
  it('builds gemini URL with safe {model} substitution', () => {
    registerProviderRoutes(KIE_ROUTES);
    const { url, route } = resolveRouteUrl(KIE_PROVIDER_ID, KIE_BASE_URL, 'gemini-3-8-flash');
    expect(route.id).toBe('kie-gemini');
    expect(url).toBe('https://api.kie.ai/gemini/v1/models/gemini-3-8-flash:streamGenerateContent');
  });

  it('builds claude and codex URLs verbatim (codex path preserved)', () => {
    registerProviderRoutes(KIE_ROUTES);
    expect(resolveRouteUrl(KIE_PROVIDER_ID, KIE_BASE_URL, 'claude-opus-5').url)
      .toBe('https://api.kie.ai/claude/v1/messages');
    const codex = resolveRouteUrl(KIE_PROVIDER_ID, KIE_BASE_URL, 'gpt-5-5');
    expect(codex.route.id).toBe('kie-codex');
    expect(codex.url).toBe('https://api.kie.ai/codex/v1/responses');
  });

  it('rejects org-prefixed models for templated paths (no traversal)', () => {
    expect(() => buildRouteUrl(KIE_BASE_URL, '/gemini/v1/models/{model}:streamGenerateContent', 'google/gemini-3-8-flash'))
      .toThrow(RouteResolutionError);
  });
});

describe('protocol registry', () => {
  it('exposes exactly the four generic protocols', () => {
    expect(listProtocols().map((p) => p.id).sort())
      .toEqual(['anthropic-messages', 'gemini', 'openai-chat', 'openai-responses']);
    for (const id of ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'] as const) {
      expect(getProtocolDefinition(id)?.adapterModule).toContain('adapters/');
    }
    expect(getProtocolDefinition('nope' as any)).toBeUndefined();
  });

  it('normalizes legacy labels without breaking existing providers', () => {
    expect(isRouteProtocol('openai-chat')).toBe(true);
    expect(normalizeRouteProtocol('openai')).toBe('openai-chat');
    expect(normalizeRouteProtocol('anthropic')).toBe('anthropic-messages');
    expect(normalizeRouteProtocol('responses')).toBe('openai-responses');
    expect(normalizeRouteProtocol('unknown')).toBeUndefined();
  });
});

describe('openai-responses adapter', () => {
  const chat = {
    model: 'gpt-5-5',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is 2+2?' },
    ],
    max_tokens: 16,
  };

  it('builds Responses request and parses it back (roundtrip)', () => {
    const req = buildResponsesRequest(chat, 'gpt-5-5');
    expect(req.model).toBe('gpt-5-5');
    expect(req.instructions).toContain('Be brief.');
    expect(req.max_output_tokens).toBe(16);
    expect(req.input[0].content[0]).toMatchObject({ type: 'input_text', text: 'What is 2+2?' });
    /* stream must be pinned even when the client omitted it: upstreams that
     * default to SSE would otherwise return an event stream to a
     * non-streaming request (empty content). */
    expect(req.stream).toBe(false);
    expect(buildResponsesRequest({ ...chat, stream: true }, 'gpt-5-5').stream).toBe(true);

    const parsed = parseResponsesResponse({
      id: 'resp_1',
      model: 'gpt-5-5',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }, 'gpt-5-5');
    expect(parsed.choices[0].message.content).toBe('4');
    expect(parsed.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('preserves function calls and reasoning instead of dropping them', () => {
    const parsed = parseResponsesResponse({
      id: 'resp_2',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ text: 'think' }] },
        { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Boston"}' },
      ],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    }, 'gpt-5-5');
    expect(parsed.choices[0].finish_reason).toBe('tool_calls');
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    expect(parsed.choices[0].message.reasoning_content).toContain('think');
  });

  it('extracts usage and normalizes quota errors', () => {
    expect(extractResponsesUsage({ usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }))
      .toMatchObject({ prompt_tokens: 1, completion_tokens: 2 });
    expect(extractResponsesUsage({})).toBeNull();
    const err: any = new Error('Rate limit exceeded');
    err.status = 429;
    expect(normalizeResponsesError(err).quota).toBe(true);
  });
});

describe('anthropic-messages adapter (reused)', () => {
  it('translates chat to messages and back with usage', () => {
    const body = openaiToAnthropic({
      model: 'claude-opus-5',
      messages: [
        { role: 'system', content: 'Sys.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 20,
    });
    expect(body.system).toContain('Sys.');
    expect(body.messages).toMatchObject([{ role: 'user' }]);
    expect(body.max_tokens).toBe(20);

    const completion = anthropicToOpenAI({
      id: 'msg_1',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello' }],
      usage: { input_tokens: 8, output_tokens: 3 },
    }, 'claude-opus-5');
    expect(completion.choices[0].message.content).toBe('Hello');
    expect(extractAnthropicUsage({ usage: { input_tokens: 8, output_tokens: 3 } }))
      .toMatchObject({ prompt_tokens: 8, completion_tokens: 3 });
  });
});

describe('gemini adapter', () => {
  const chat = {
    model: 'gemini-3-8-flash',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is 2+2?' },
    ],
    temperature: 0.5,
    max_tokens: 16,
  };

  it('builds contents + systemInstruction + generationConfig with url model', () => {
    const { urlModel, body } = buildGeminiRequest(chat, 'gemini-3-8-flash');
    expect(urlModel).toBe('gemini-3-8-flash');
    expect(body.systemInstruction.parts[0].text).toContain('Be brief.');
    expect(body.contents[0]).toMatchObject({ role: 'user' });
    expect(body.contents[0].parts[0]).toMatchObject({ text: 'What is 2+2?' });
    expect(body.generationConfig).toMatchObject({ temperature: 0.5, maxOutputTokens: 16 });
  });

  it('maps function tools to functionDeclarations and keeps thoughts', () => {
    const { body } = buildGeminiRequest({
      model: 'gemini-3-8-flash',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }],
    }, 'gemini-3-8-flash');
    expect(body.tools[0].functionDeclarations[0].name).toBe('get_weather');
  });

  it('parses candidates, functionCall, usageMetadata and thoughtSignature', () => {
    const parsed = parseGeminiResponse({
      responseId: 'r1',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { text: '4' },
            { functionCall: { name: 'f', args: { a: 1 } } },
            { text: 'hmm', thought: true, thoughtSignature: 'sig123' },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
    }, 'gemini-3-8-flash');
    expect(parsed.choices[0].message.content).toBe('4');
    expect(parsed.choices[0].finish_reason).toBe('tool_calls');
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe('f');
    expect(parsed.choices[0].message.reasoning_content).toContain('hmm');
    expect(parsed.choices[0].message.thought_signature).toBe('sig123');
    expect(parsed.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it('parses stream chunks to openai chunks and maps RESOURCE_EXHAUSTED to quota', () => {
    const chunk = parseGeminiStreamChunk({
      responseId: 'r2',
      candidates: [{ content: { parts: [{ text: 'hel' }] } }],
    }, 'gemini-3-8-flash');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices[0].delta.content).toBe('hel');

    expect(extractGeminiUsage({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }))
      .toMatchObject({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(extractGeminiUsage({})).toBeNull();
    const err: any = new Error('RESOURCE_EXHAUSTED quota');
    err.response = { status: 429, data: { error: { message: 'RESOURCE_EXHAUSTED', status: 'RESOURCE_EXHAUSTED' } } };
    const norm = normalizeGeminiError(err);
    expect(norm.status).toBe(429);
    expect(norm.quota).toBe(true);
  });
});

describe('openai-chat passthrough untouched', () => {
  it('passes payload through and reads standard usage', () => {
    const p = { model: 'x', messages: [] };
    expect(buildOpenAIChatRequest(p)).toEqual(p);
    expect(extractOpenAIChatUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
      .toMatchObject({ prompt_tokens: 1 });
  });
});

describe('same-provider key rotation untouched', () => {
  it('round-robins within one provider pool only', async () => {
    const km = new KeyManager(['k1', 'k2', 'k3'], 'RouteTest');
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const k = await km.getNextKey();
      seen.add(k.index);
      km.markSuccess(k.index, 1);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(km.keyCount).toBe(3);
  });
});

describe('combo routeId backward compatibility', () => {
  const base: any = {
    id: 'combo_1',
    clientKeyId: 'ck',
    providerId: 'kie',
    model: 'gemini-3-8-flash',
    providerKeyId: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    requestCount: 0,
    lastUsedAt: null,
  };

  it('legacy combo without routeId exposes routeId null', () => {
    expect(toPublicCombo(base).routeId).toBeNull();
  });

  it('combo with routeId round-trips the route', () => {
    expect(toPublicCombo({ ...base, routeId: 'kie-gemini' }).routeId).toBe('kie-gemini');
  });
});
