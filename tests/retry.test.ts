import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { isRetryableError, isQuotaError, isInsufficientBalanceError, normalizeStreamError } from '../src/lib/retry';

function axiosError(status: number, body: any, message?: string): any {
  const err: any = new Error(message ?? `Request failed with status code ${status}`);
  err.response = { status, data: body };
  return err;
}

describe('isInsufficientBalanceError', () => {
  it('matches Cline 402 insufficient_credits', () => {
    const e = axiosError(402, { error: { code: 'insufficient_credits', message: 'Insufficient balance. balance is $0.01', current_balance: 0.009 } });
    expect(isInsufficientBalanceError(e)).toBe(true);
  });

  it('matches BAI 400 insufficient_user_quota', () => {
    const e = axiosError(400, { error: { message: 'credit insufficient balance: balance=0 required=102', code: 'insufficient_user_quota' } });
    expect(isInsufficientBalanceError(e)).toBe(true);
  });

  it('does not match plain 400 validation errors', () => {
    const e = axiosError(400, { error: { message: 'max_tokens must be greater than 2', code: 'invalid_request' } });
    expect(isInsufficientBalanceError(e)).toBe(false);
  });

  it('does not match 402 without balance signal', () => {
    const e = axiosError(402, { error: { message: 'Payment required' } });
    expect(isInsufficientBalanceError(e)).toBe(false);
  });

  it('does not match 500s or 429s', () => {
    expect(isInsufficientBalanceError(axiosError(500, {}))).toBe(false);
    expect(isInsufficientBalanceError(axiosError(429, {}))).toBe(false);
  });
});

describe('retry/quota integration for balance errors', () => {
  it('isRetryableError fails over on balance errors', () => {
    const e = axiosError(402, { error: { code: 'insufficient_credits', message: 'Insufficient balance $0' } });
    expect(isRetryableError(e)).toBe(true);
  });

  it('isQuotaError cools down balance-dead keys', () => {
    const e = axiosError(400, { error: { message: 'credit insufficient balance: balance=0', code: 'insufficient_user_quota' } });
    expect(isQuotaError(e)).toBe(true);
  });

  it('plain 400 stays non-retryable and non-quota', () => {
    const e = axiosError(400, { error: { message: 'model is required' } });
    expect(isRetryableError(e)).toBe(false);
    expect(isQuotaError(e)).toBe(false);
  });
});

describe('normalizeStreamError', () => {
  it('drains a stream body so balance classification works', async () => {
    const body = JSON.stringify({ error: { code: 'insufficient_credits', message: 'Insufficient balance $0' } });
    const stream = Readable.from([body]);
    const e: any = new Error('Request failed with status code 402');
    e.response = { status: 402, data: stream };
    expect(isInsufficientBalanceError(e)).toBe(false); // unread stream: no signal yet
    await normalizeStreamError(e);
    expect(isInsufficientBalanceError(e)).toBe(true);
    expect(isRetryableError(e)).toBe(true);
    expect(isQuotaError(e)).toBe(true);
  });

  it('leaves non-stream errors untouched', async () => {
    const e = axiosError(429, { error: { message: 'slow down' } });
    const out = await normalizeStreamError(e);
    expect(out).toBe(e);
    expect(isQuotaError(e)).toBe(true);
  });
});
