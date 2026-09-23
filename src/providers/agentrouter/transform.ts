// OpenAI Chat Completions <-> Anthropic Messages translation.
//
// The proxy speaks OpenAI everywhere. When a model only supports the Anthropic
// Messages API we translate the inbound OpenAI request into an Anthropic request
// (here) and the Anthropic response back into an OpenAI Chat Completion shape
// (response.ts). OpenAI-compatible models never go through here. In proxy mode
// no translation is applied at all.

import { config } from '../../config';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  [k: string]: any;
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function contentToBlocks(content: any): AnthropicContentBlock[] | string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return contentToText(content);
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
    } else if (part?.type === 'text') {
      blocks.push({ type: 'text', text: part.text ?? '' });
    } else if (part?.type === 'image_url' && part.image_url?.url) {
      const url: string = part.image_url.url;
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  return blocks.length > 0 ? blocks : '';
}

/**
 * Translate an OpenAI Chat Completions payload into an Anthropic Messages body.
 */
export function openaiToAnthropic(payload: any): any {
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts: string[] = [];
  const converted: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(contentToText(msg.content));
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    converted.push({ role, content: contentToBlocks(msg.content) });
  }

  const body: any = {
    model: payload.model,
    messages: converted,
    max_tokens: payload.max_tokens ?? config.defaultMaxTokens,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (payload.temperature !== undefined) body.temperature = payload.temperature;
  if (payload.top_p !== undefined) body.top_p = payload.top_p;
  if (payload.stop !== undefined) {
    body.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  }
  if (payload.stream) body.stream = true;

  if (Array.isArray(payload.tools)) {
    body.tools = payload.tools
      .filter((t: any) => t?.type === 'function' && t.function)
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    if (payload.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (payload.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (payload.tool_choice && payload.tool_choice.function?.name) {
      body.tool_choice = { type: 'tool', name: payload.tool_choice.function.name };
    }
  }

  return body;
}