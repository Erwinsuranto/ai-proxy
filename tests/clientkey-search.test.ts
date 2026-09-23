/* Pure-behaviour tests for the Client API Key form search rules (Node, no
 * DOM): provider search (name/id/case/partial/no-result) and model search
 * (id/case/partial/no-result/huge catalogs), asserting the rules NEVER alter
 * ids and only partition the already-loaded data. UI wiring (served bundle)
 * is asserted in admin-ui.test.ts; the create-flow E2E regression stays in
 * client-api-keys.test.ts. */
import { describe, it, expect } from 'vitest';
import { matchesSearchFilter, filterProviderCatalog, filterModelIds } from '../src/admin/dashboard';

const PROVIDERS = [
  { id: 'nvidia', name: 'NVIDIA NIM', models: ['z-ai/glm-5.2'] },
  { id: 'openrouter', name: 'OpenRouter', models: ['anthropic/claude-fable-5'] },
  { id: 'justwoker', name: 'JustWoker', models: ['claude-opus-5'] },
  { id: 'kie.ai', name: 'Kie.ai', models: ['gpt-5-6-luna'] },
];

describe('provider search (filterProviderCatalog)', () => {
  it('matches by display NAME (partial, case-insensitive)', () => {
    expect(filterProviderCatalog(PROVIDERS, 'just').map(p => p.id)).toEqual(['justwoker']);
    expect(filterProviderCatalog(PROVIDERS, 'WOK').map(p => p.id)).toEqual(['justwoker']);
    expect(filterProviderCatalog(PROVIDERS, 'nim').map(p => p.id)).toEqual(['nvidia']);
  });

  it('matches by provider ID (partial, case-insensitive)', () => {
    expect(filterProviderCatalog(PROVIDERS, 'nvidia').map(p => p.id)).toEqual(['nvidia']);
    expect(filterProviderCatalog(PROVIDERS, 'NVIDIA').map(p => p.id)).toEqual(['nvidia']);
    expect(filterProviderCatalog(PROVIDERS, 'kie').map(p => p.id)).toEqual(['kie.ai']);
    expect(filterProviderCatalog(PROVIDERS, 'open').map(p => p.id)).toEqual(['openrouter']);
  });

  it('empty / whitespace query returns every provider', () => {
    expect(filterProviderCatalog(PROVIDERS, '')).toHaveLength(4);
    expect(filterProviderCatalog(PROVIDERS, '   ')).toHaveLength(4);
  });

  it('no match → empty (UI renders "No providers found")', () => {
    expect(filterProviderCatalog(PROVIDERS, 'zzz-nothing')).toHaveLength(0);
  });

  it('filtering is side-effect free: catalog untouched, original ids returned', () => {
    const before = JSON.stringify(PROVIDERS);
    filterProviderCatalog(PROVIDERS, 'kie');
    expect(JSON.stringify(PROVIDERS)).toBe(before);
  });
});

describe('model search (filterModelIds + matchesSearchFilter)', () => {
  const MODELS = ['GLM-5.3-Flash', 'glm-5.3', 'DeepSeek-V4.1-Flash', 'nemotron-3-super-free'];

  it('partial, case-insensitive matching against the exact model id', () => {
    expect(filterModelIds(MODELS, 'glm-5.3')).toEqual(['GLM-5.3-Flash', 'glm-5.3']);
    expect(filterModelIds(MODELS, 'DEEPSEEK')).toEqual(['DeepSeek-V4.1-Flash']);
    expect(filterModelIds(MODELS, 'v4.1-flash')).toEqual(['DeepSeek-V4.1-Flash']);
    expect(filterModelIds(MODELS, 'NEMOTRON')).toEqual(['nemotron-3-super-free']);
  });

  it('no result → empty (UI renders "No models found")', () => {
    expect(filterModelIds(MODELS, 'claude')).toHaveLength(0);
  });

  it('ids are NEVER rewritten — filter returns the original strings (selection-safe)', () => {
    const hits = filterModelIds(MODELS, 'glm');
    hits.forEach(h => expect(MODELS.includes(h)).toBe(true));
    /* the full set can be cleared back: empty query yields every model, so a
     * selection made before filtering is still addressable afterwards */
    expect(filterModelIds(MODELS, '  ')).toEqual(MODELS);
  });

  it('1000+ model catalogs filter instantly, in-memory (no request)', () => {
    const big = Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? `muse-spark-1.${i}` : `other/model-${i}`));
    const t0 = Date.now();
    const hits = filterModelIds(big, 'muse-spark-1');
    const ms = Date.now() - t0;
    expect(hits.length).toBe(Math.ceil(5000 / 7));
    expect(ms).toBeLessThan(250);
  });

  it('null/undefined haystacks are simply non-matching, not crashing', () => {
    expect(matchesSearchFilter('x', undefined)).toBe(false);
    expect(matchesSearchFilter('x', null)).toBe(false);
    expect(matchesSearchFilter('', undefined)).toBe(true);
  });
});
