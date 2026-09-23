/* ============================================================================
 * nvidia-api · gemini protocol adapter (upstream streamGenerateContent)
 * ----------------------------------------------------------------------------
 * Translates the gateway's internal OpenAI Chat shape to Gemini
 * `streamGenerateContent` / `generateContent` bodies and normalizes Gemini
 * responses (candidates/usageMetadata) back to chat completions.
 * Thinking output is preserved as `reasoning_content`; thought signatures
 * are kept on the message instead of being dropped.
 * ========================================================================== */
import { Transform } from 'stream';

function chatContentToGeminiParts(content: any): any[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) parts.push({ text: p });
    } else if (p?.type === 'text' && typeof p.text === 'string') {
      parts.push({ text: p.text });
    } else if (p?.type === 'image_url' && p.image_url?.url) {
      const url: string = p.image_url.url;
      const b64 = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (b64) {
        parts.push({ inlineData: { mimeType: b64[1], data: b64[2] } });
      } else if (/^https?:\/\//.test(url)) {
        const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
        const mime = ext === 'png' ? 'image/png'
          : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
              : 'image/jpeg';
        parts.push({ fileData: { mimeType: mime, fileUri: url } });
      }
    }
  }
  return parts;
}

function toGeminiRole(role: any): string {
  return role === 'assistant' || role === 'model' ? 'model' : 'user';
}

/** Translate an internal chat payload into a Gemini request body. */
export function buildGeminiRequest(chatPayload: any, backendModel: string): { urlModel: string; body: any } {
  const messages: any[] = Array.isArray(chatPayload?.messages) ? chatPayload.messages : [];
  const systemTexts: string[] = [];
  const contents: any[] = [];
  const pendingToolCalls = new Map<string, string>();

  for (const msg of messages) {
    if (msg?.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : chatContentToGeminiParts(msg.content).map((p: any) => p.text ?? '').join('');
      if (text) systemTexts.push(text);
      continue;
    }
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && tc?.function?.name) pendingToolCalls.set(tc.id, tc.function.name);
      }
    }
    if (msg?.role === 'tool') {
      const name = msg.name ?? pendingToolCalls.get(msg.tool_call_id) ?? 'unknown';
      let response: any = { content: typeof msg.content === 'string' ? msg.content : '' };
      if (typeof msg.content === 'string') {
        try { response = JSON.parse(msg.content); } catch { response = { content: msg.content }; }
      }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
      continue;
    }
    const parts = chatContentToGeminiParts(msg?.content);
    if (parts.length === 0) continue;
    contents.push({ role: toGeminiRole(msg?.role), parts });
  }

  const body: any = { contents };
  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }

  const generationConfig: any = {};
  if (chatPayload?.temperature !== undefined) generationConfig.temperature = chatPayload.temperature;
  if (chatPayload?.top_p !== undefined) generationConfig.topP = chatPayload.top_p;
  if (chatPayload?.max_tokens !== undefined) generationConfig.maxOutputTokens = chatPayload.max_tokens;
  if (chatPayload?.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(chatPayload.stop) ? chatPayload.stop : [chatPayload.stop];
  }
  const thinking = chatPayload?.thinkingConfig ?? chatPayload?.reasoning?.thinkingConfig;
  if (thinking !== undefined) generationConfig.thinkingConfig = thinking;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  if (Array.isArray(chatPayload?.tools) && chatPayload.tools.length > 0) {
    const declarations: any[] = [];
    const passthrough: any[] = [];
    for (const t of chatPayload.tools) {
      if (t?.type === 'function' && t.function?.name) {
        declarations.push({
          name: t.function.name,
          description: t.function.description ?? '',
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        });
      } else if (t?.googleSearch !== undefined || t?.google_search_retrieval !== undefined || t?.codeExecution !== undefined) {
        passthrough.push(t);
      }
    }
    const tools: any[] = [];
    if (declarations.length > 0) tools.push({ functionDeclarations: declarations });
    tools.push(...passthrough);
    if (tools.length > 0) body.tools = tools;
  }

  if (chatPayload?.safetySettings !== undefined) body.safetySettings = chatPayload.safetySettings;
  if (chatPayload?.stream !== undefined) body.stream = !!chatPayload.stream;
  return { urlModel: backendModel, body };
}

const GEMINI_FINISH_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  LANGUAGE: 'stop',
  OTHER: 'stop',
  FINISH_REASON_UNSPECIFIED: 'stop',
};

function partsToMessage(parts: any[]): { content: string; toolCalls: any[]; reasoning: string; thoughtSignature: string } {
  const texts: string[] = [];
  const toolCalls: any[] = [];
  const reasoning: string[] = [];
  let thoughtSignature = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text) {
      if (part.thought === true) reasoning.push(part.text);
      else texts.push(part.text);
    }
    if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature && !thoughtSignature) {
      thoughtSignature = part.thoughtSignature;
    }
  }
  return { content: texts.join(''), toolCalls, reasoning: reasoning.join('\n'), thoughtSignature };
}

/** Normalize a Gemini response body into an OpenAI chat completion. */
export function parseGeminiResponse(resp: any, requestedModel: string): any {
  const obj = resp && typeof resp === 'object' ? resp : {};
  const candidates: any[] = Array.isArray(obj.candidates) ? obj.candidates : [];
  const first = candidates[0] ?? {};
  const parts: any[] = Array.isArray(first.content?.parts) ? first.content.parts : [];
  const { content, toolCalls, reasoning, thoughtSignature } = partsToMessage(parts);

  const message: any = { role: 'assistant', content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  if (thoughtSignature) message.thought_signature = thoughtSignature;

  const usage = extractGeminiUsage(obj);
  return {
    id: obj.responseId ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0
          ? 'tool_calls'
          : (GEMINI_FINISH_MAP[first.finishReason] ?? 'stop'),
      },
    ],
    usage: usage
      ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
      : null,
  };
}

/** Normalize one Gemini stream chunk into an OpenAI chat chunk. */
export function parseGeminiStreamChunk(chunk: any, requestedModel: string): any {
  const parsed = parseGeminiResponse(chunk, requestedModel);
  const message = parsed.choices[0]?.message ?? {};
  const delta: any = {};
  if (message.content) delta.content = message.content;
  if (message.tool_calls) delta.tool_calls = message.tool_calls;
  if (message.reasoning_content) delta.reasoning_content = message.reasoning_content;
  return {
    id: parsed.id,
    object: 'chat.completion.chunk',
    created: parsed.created,
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

export function extractGeminiUsage(resp: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  const u = resp?.usageMetadata ?? resp?.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = u.promptTokenCount ?? u.prompt_tokens ?? u.input_tokens;
  const completion = u.candidatesTokenCount ?? u.completion_tokens ?? u.output_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: typeof u.totalTokenCount === 'number'
      ? u.totalTokenCount
      : typeof u.total_tokens === 'number' ? u.total_tokens : prompt + completion,
  };
}

export function normalizeGeminiError(error: any): { status: number; message: string; quota: boolean } {

  const status = error?.status ?? error?.response?.status ?? error?.code ?? 500;
  let body: any = error?.response?.data ?? error?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const message = body?.error?.message ?? body?.message ?? error?.message ?? 'upstream gemini error';
  const statusText = String(body?.error?.status ?? '').toUpperCase();
  const text = String(message).toLowerCase();
  const quota = status === 429
    || statusText === 'RESOURCE_EXHAUSTED'
    || text.includes('resource_exhausted')
    || text.includes('rate limit')
    || text.includes('quota')
    || text.includes('too many requests');
  return { status: typeof status === 'number' ? status : 500, message: String(message), quota };
}

/* Streaming: transcode Gemini SSE/JSON chunks into OpenAI chat chunks.
 * Upstream frames are `data: {GenerateContentResponse}` lines; a non-SSE
 * single JSON body is also accepted (emitted once, then [DONE]). */
export function createGeminiToOpenAIStream(requestedModel: string): Transform {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now()}`;
  let buffer = '';
  let roleSent = false;
  let doneSent = false;

  const chunk = (delta: any): string => `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
  const done = (): string => {
    if (doneSent) return '';
    doneSent = true;
    return 'data: [DONE]\n\n';
  };

  function emitJson(obj: any, push: (s: string) => void): void {
    const parsed = parseGeminiResponse(obj, requestedModel);
    const message = parsed.choices[0]?.message ?? {};
    if (!roleSent) {
      roleSent = true;
      push(chunk({ role: 'assistant', content: '' }));
    }
    const delta: any = {};
    if (message.content) delta.content = message.content;
    if (message.tool_calls) delta.tool_calls = message.tool_calls;
    if (message.reasoning_content) delta.reasoning_content = message.reasoning_content;
    if (Object.keys(delta).length > 0) push(chunk(delta));
  }

  return new Transform({
    transform(piece: any, _enc: any, cb: any) {
      try {
        buffer += piece.toString('utf8');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const raw of frames) {
          const lines = raw.split('\n').map((l: string) => l.trim()).filter(Boolean);
          if (lines.length === 0) continue;
          const dataLines = lines.filter((l: string) => l.startsWith('data:'));
          if (dataLines.length === 0) {
            // Non-SSE JSON chunk — try once as a whole object.
            try { emitJson(JSON.parse(raw), (s: string) => this.push(s)); } catch { /* ignore */ }
            continue;
          }
          for (const line of dataLines) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { this.push(done()); continue; }
            try { emitJson(JSON.parse(payload), (s: string) => this.push(s)); } catch { /* ignore partial */ }
          }
        }
        cb(null);
      } catch (err: any) {
        cb(err);
      }
    },
    flush(cb: any) {
      try {
        const tail = buffer.trim();
        if (tail) {
          const payload = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
          if (payload && payload !== '[DONE]') {
            try {
              const self: any = this;
              emitJson(JSON.parse(payload), (s: string) => self.push(s));
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      this.push(done());
      cb(null);
    },
  });
}
