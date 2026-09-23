import { KeyManager, AllKeysCooldownError, KeyInfo } from './key-manager';
import { EndpointManager, AllEndpointsCooldownError, EndpointInfo } from './endpoint-manager';
import { isRetryableError, isQuotaError } from './retry';

export interface KeyRotationHandlers<T> {
  request: (key: string) => Promise<T>;
  onTrying?: (keyIndex: number, keySuffix: string) => void;
  onSuccess?: (keyIndex: number, latencyMs: number) => void;
  onCooldown?: (keyIndex: number, status: number) => void;
  onRotate?: (keyIndex: number, error: any, status: number, isTimeout: boolean) => void;
}

export async function withKeyRotation<T>(
  keyManager: KeyManager,
  handlers: KeyRotationHandlers<T>,
): Promise<T> {
  let lastError: any = null;
  const triedIndices = new Set<number>();

  for (let attempt = 0; attempt < keyManager.keyCount; attempt++) {
    let keyInfo: KeyInfo;
    try {
      keyInfo = await keyManager.getNextKey();
    } catch (e) {
      if (e instanceof AllKeysCooldownError) {
        throw lastError ?? e;
      }
      throw e;
    }

    if (triedIndices.has(keyInfo.index)) continue;
    triedIndices.add(keyInfo.index);

    handlers.onTrying?.(keyInfo.index, keyInfo.masked);

    const start = Date.now();
    try {
      const result = await handlers.request(keyInfo.key);
      const latency = Date.now() - start;
      keyManager.markSuccess(keyInfo.index, latency);
      handlers.onSuccess?.(keyInfo.index, latency);
      return result;
    } catch (error: any) {
      lastError = error;
      const status = error?.status ?? error?.response?.status ?? 0;
      const isTimeout = error?.code === 'ECONNABORTED' || (error?.message && error.message.includes('timeout'));

      if (isQuotaError(error)) {
        keyManager.markCooldown(keyInfo.index);
        handlers.onCooldown?.(keyInfo.index, status);
      } else {
        keyManager.markFailure(keyInfo.index, error.message ?? String(error));
        handlers.onRotate?.(keyInfo.index, error, status, isTimeout);
      }

      if (attempt < keyManager.keyCount - 1 && isRetryableError(error)) {
        continue;
      }
    }
  }

  throw lastError ?? new Error('All keys failed');
}

export interface EndpointRotationHandlers<T> {
  request: (baseUrl: string, apiKey: string) => Promise<T>;
  onTrying?: (index: number, maskedBaseUrl: string) => void;
  onSuccess?: (index: number, latencyMs: number) => void;
  onCooldown?: (index: number, status: number) => void;
  onRotate?: (index: number, error: any, status: number, isTimeout: boolean) => void;
}

export async function withEndpointRotation<T>(
  manager: EndpointManager,
  handlers: EndpointRotationHandlers<T>,
  orderedPool?: number[],
): Promise<T> {
  let lastError: any = null;
  const triedIndices = new Set<number>();

  const maxAttempts = orderedPool ? orderedPool.length : manager.endpointCount;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let ep: EndpointInfo;

    if (orderedPool) {
      const idx = orderedPool[attempt];
      ep = manager.getEndpointInfo(idx);
    } else {
      try {
        ep = await manager.getNextEndpoint();
      } catch (e) {
        if (e instanceof AllEndpointsCooldownError) {
          throw lastError ?? e;
        }
        throw e;
      }
    }

    if (triedIndices.has(ep.index)) continue;
    triedIndices.add(ep.index);

    handlers.onTrying?.(ep.index, ep.maskedBaseUrl);

    const start = Date.now();
    try {
      const result = await handlers.request(ep.baseUrl, ep.apiKey);
      const latency = Date.now() - start;
      manager.markSuccess(ep.index, latency);
      handlers.onSuccess?.(ep.index, latency);
      return result;
    } catch (error: any) {
      lastError = error;
      const status = error?.status ?? error?.response?.status ?? 0;
      const isTimeout = error?.code === 'ECONNABORTED' || (error?.message && error.message.includes('timeout'));

      if (isQuotaError(error)) {
        manager.markCooldown(ep.index);
        handlers.onCooldown?.(ep.index, status);
      } else {
        manager.markFailure(ep.index, error.message ?? String(error));
        handlers.onRotate?.(ep.index, error, status, isTimeout);
      }

      if (attempt < maxAttempts - 1 && isRetryableError(error)) {
        continue;
      }
    }
  }

  throw lastError ?? new Error('All endpoints failed');
}
