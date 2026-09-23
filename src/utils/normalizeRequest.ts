export function normalizeRequest(providerId: string, payload: any): any {
  const normalized = { ...payload };

  if (providerId === 'databricks') {
    if (normalized.max_tokens !== undefined && normalized.max_tokens < 1) {
      console.log(`[Normalize] Original max_tokens: ${normalized.max_tokens}`);
      delete normalized.max_tokens;
      console.log(`[Normalize] Normalized max_tokens: <removed>`);
      console.log(`[Normalize] Provider: ${providerId}`);
    }
  }

  return normalized;
}
