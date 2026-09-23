import { v4 as uuidv4 } from 'uuid';

/** Creates the SSE `data: [DONE]` termination chunk for streaming responses. */
export function createDoneChunk(): string {
  return 'data: [DONE]\n\n';
}

/** Formats a raw embedding API response into an OpenAI-compatible structure. */
export function createEmbeddingResponse(data: any, model: string): any {
  return {
    id: data.id ?? `emb-${uuidv4().replace(/-/g, '')}`,
    object: 'list',
    data: (data.data ?? []).map((item: any) => ({
      object: 'embedding',
      index: item.index ?? 0,
      embedding: item.embedding ?? [],
    })),
    model,
    usage: data.usage ?? {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  };
}

/** Creates an OpenAI-compatible error response object with the given status code and message. */
export function openAIError(status: number, message: string): any {
  const typeMap: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found',
    422: 'invalid_request_error',
    429: 'rate_limit_error',
    500: 'internal_server_error',
    502: 'bad_gateway',
    503: 'service_unavailable',
  };
  return {
    error: {
      message,
      type: typeMap[status] ?? 'api_error',
      code: status.toString(),
    },
  };
}
