/** Returns a formatted key log tag string for the given 0-based index (e.g. `[KEY#1]`). */
export function keyTag(index: number): string {
  return `[KEY#${index + 1}]`;
}

/** Logs an informational message prefixed with the given tag. */
export function logInfo(tag: string, message: string): void {
  console.log(`${tag} ${message}`);
}

/** Logs a warning message in yellow prefixed with the given tag. */
export function logWarn(tag: string, message: string): void {
  console.warn(`${tag} \x1b[33m${message}\x1b[0m`);
}

/** Logs an error message in red prefixed with the given tag. */
export function logError(tag: string, message: string): void {
  console.error(`${tag} \x1b[31m${message}\x1b[0m`);
}

/** Logs a success message in green prefixed with the given tag. */
export function logSuccess(tag: string, message: string): void {
  console.log(`${tag} \x1b[32m${message}\x1b[0m`);
}

/** Logs an API request with the given model identifier. */
export function logRequest(tag: string, model: string): void {
  logInfo(tag, `Request model=${model}`);
}

/** Logs a successful request with its measured latency in milliseconds. */
export function logSuccessLatency(tag: string, latencyMs: number): void {
  logSuccess(tag, `Success ${latencyMs}ms`);
}

/** Logs a retry attempt with the reason (e.g. HTTP status code). */
export function logRetry(tag: string, reason: string): void {
  logWarn(tag, `Retry after ${reason}`);
}

/** Logs that a key has been placed into cooldown for the given duration in seconds. */
export function logCooldown(tag: string, seconds: number): void {
  logWarn(tag, `Cooldown ${seconds}s`);
}

/** Logs that a key is being tried as a retry candidate. */
export function logTrying(tag: string): void {
  logWarn(tag, `Trying...`);
}

/** Logs that a key was rate-limited (HTTP 429) and placed into cooldown. */
export function logRateLimited(tag: string, seconds: number): void {
  logWarn(tag, `429 -> Cooldown ${seconds}s`);
}
