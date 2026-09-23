/** Per-key usage statistics tracking requests, successes, failures, retries, latency, and cooldown state. */
export interface KeyStats {
  requestCount: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  lastUsed: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  disabledUntil: number | null;
  averageLatency: number;
  totalLatency: number;
}

/** Creates a new KeyStats instance with all fields initialized to zero/default values. */
export function createStats(): KeyStats {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    retryCount: 0,
    lastUsed: null,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    disabledUntil: null,
    averageLatency: 0,
    totalLatency: 0,
  };
}

/** Increments the request count and updates the last-used timestamp for a key. */
export function recordRequest(stats: KeyStats): void {
  stats.requestCount++;
  stats.lastUsed = Date.now();
}

/** Returns a sanitized stats snapshot for a key suitable for external/admin endpoints. */
export function getPublicStats(index: number, stats: KeyStats) {
  return {
    id: index + 1,
    active: stats.disabledUntil === null || stats.disabledUntil <= Date.now(),
    cooldown: stats.disabledUntil !== null && stats.disabledUntil > Date.now(),
    requests: stats.requestCount,
    success: stats.successCount,
    failed: stats.failureCount,
    retry: stats.retryCount,
    averageLatency: stats.averageLatency,
    lastError: stats.lastError,
    lastUsed: stats.lastUsed,
  };
}
