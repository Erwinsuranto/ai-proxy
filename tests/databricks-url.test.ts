import { describe, it, expect } from 'vitest';
import { joinDatabricksUrl } from '../src/providers/databricks/url-utils';

describe('joinDatabricksUrl', () => {
  it('appends path to base URL without trailing slash', () => {
    expect(joinDatabricksUrl('https://example.com/serving-endpoints', '/chat/completions'))
      .toBe('https://example.com/serving-endpoints/chat/completions');
  });

  it('strips trailing slash from base URL', () => {
    expect(joinDatabricksUrl('https://example.com/serving-endpoints/', '/chat/completions'))
      .toBe('https://example.com/serving-endpoints/chat/completions');
  });

  it('strips leading slash from path', () => {
    expect(joinDatabricksUrl('https://example.com/serving-endpoints', 'chat/completions'))
      .toBe('https://example.com/serving-endpoints/chat/completions');
  });

  it('deduplicates when base ends with same segment as path starts', () => {
    expect(joinDatabricksUrl('https://example.com/ai-gateway/mlflow/v1', '/v1/models'))
      .toBe('https://example.com/ai-gateway/mlflow/v1/models');
  });

  it('deduplicates /v1 with /v1/chat/completions', () => {
    expect(joinDatabricksUrl('https://example.com/ai-gateway/mlflow/v1', '/v1/chat/completions'))
      .toBe('https://example.com/ai-gateway/mlflow/v1/chat/completions');
  });

  it('does not deduplicate when segments differ', () => {
    expect(joinDatabricksUrl('https://example.com/ai-gateway/mlflow/v1', '/chat/completions'))
      .toBe('https://example.com/ai-gateway/mlflow/v1/chat/completions');
  });

  it('does not deduplicate when base ends with serving-endpoints', () => {
    expect(joinDatabricksUrl('https://example.com/serving-endpoints', '/v1/models'))
      .toBe('https://example.com/serving-endpoints/v1/models');
  });

  it('handles base URL with auth token in path', () => {
    expect(joinDatabricksUrl('https://dbc-xxx.cloud.databricks.com/ai-gateway/mlflow/v1', '/v1/models'))
      .toBe('https://dbc-xxx.cloud.databricks.com/ai-gateway/mlflow/v1/models');
  });

  it('handles multiple leading slashes in path', () => {
    expect(joinDatabricksUrl('https://example.com/v1', '//v1/models'))
      .toBe('https://example.com/v1/models');
  });

  it('handles empty base URL', () => {
    expect(joinDatabricksUrl('', '/v1/models')).toBe('v1/models');
  });

  it('handles empty path', () => {
    expect(joinDatabricksUrl('https://example.com/v1', '')).toBe('https://example.com/v1');
  });

  it('does not break regular joining when no overlap', () => {
    expect(joinDatabricksUrl('https://example.com/base', '/path/to/resource'))
      .toBe('https://example.com/base/path/to/resource');
  });
});
