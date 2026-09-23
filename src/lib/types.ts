export interface ProviderInfo {
  providerId: string;
  providerName: string;
}

export interface Provider {
  getProviderInfo(): ProviderInfo;
  chatCompletion(payload: any): Promise<any>;
  chatCompletionRaw(payload: any): Promise<string>;
  chatCompletionStream(payload: any): Promise<{ stream: any; keyIndex: number; tag: string }>;
  listModels(): Promise<any>;
  healthCheck?(): Promise<any>;
  createEmbedding(payload: any): Promise<any>;
}

export const CLOUDFLARE_MODEL_MAP: Record<string, string> = {
  'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
  'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'llama-3.2-3b': '@cf/meta/llama-3.2-3b-instruct',
  'llama-3.2-1b': '@cf/meta/llama-3.2-1b-instruct',
  'whisper-large-v3': '@cf/openai/whisper-large-v3',
};
