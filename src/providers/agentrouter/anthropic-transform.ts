// Backward-compatibility re-export shim. The actual OpenAI<->Anthropic
// translation now lives in transform.ts (request) and response.ts / stream.ts
// (response). This file keeps the previous import path working.

export { openaiToAnthropic } from './transform';
export { anthropicToOpenAI } from './response';
export { createAnthropicToOpenAIStream } from './stream';