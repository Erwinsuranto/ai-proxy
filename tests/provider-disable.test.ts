import { describe, it, expect } from 'vitest';
import { registry } from '../src/providers/registry';
import { modelRegistry } from '../src/lib/model-registry';
import { Provider, ProviderInfo } from '../src/lib/types';

class TestProvider implements Provider {
  info: ProviderInfo;
  constructor(id: string) { this.info = { providerId: id, providerName: id }; }
  getProviderInfo(): ProviderInfo { return this.info; }
  chatCompletion(_p: any): Promise<any> { return Promise.resolve({}); }
  chatCompletionRaw(_p: any): Promise<string> { return Promise.resolve('{}'); }
  chatCompletionStream(_p: any): Promise<any> { return Promise.resolve({ stream: {}, keyIndex: 0, tag: '' }); }
  listModels(): Promise<any> { return Promise.resolve({ object: 'list', data: [] }); }
  createEmbedding(_p: any): Promise<any> { return Promise.resolve({}); }
}

const provA = new TestProvider('test-alpha');
const provB = new TestProvider('test-beta');

registry.register(provA.getProviderInfo(), provA, () => false);
registry.register(provB.getProviderInfo(), provB, () => false);

describe('Provider Disable - Registry Filtering', () => {
  afterEach(() => {
    registry.setDisabled([]);
  });

  it('setDisabled/getDisabledProviders roundtrip', () => {
    registry.setDisabled(['test-alpha', 'test-beta']);
    const disabled = registry.getDisabledProviders();
    expect(disabled).toContain('test-alpha');
    expect(disabled).toContain('test-beta');
  });

  it('getEnabledProviderIds excludes disabled', () => {
    registry.setDisabled(['test-alpha']);
    const enabled = registry.getEnabledProviderIds();
    expect(enabled).toContain('test-beta');
    expect(enabled).not.toContain('test-alpha');
  });

  it('getAllConfiguredProviders excludes disabled', () => {
    registry.setDisabled(['test-alpha']);
    const all = registry.getAllConfiguredProviders();
    const ids = all.map(p => p.identity.providerId);
    expect(ids).not.toContain('test-alpha');
    expect(ids).toContain('test-beta');
  });

  it('getProviderById returns undefined for disabled', () => {
    registry.setDisabled(['test-alpha']);
    expect(registry.getProviderById('test-alpha')).toBeUndefined();
    expect(registry.getProviderById('test-beta')).toBeDefined();
  });

  it('isConfigured returns false for disabled', () => {
    registry.setDisabled(['test-alpha']);
    expect(registry.isConfigured('test-alpha')).toBe(false);
    expect(registry.isConfigured('test-beta')).toBe(true);
  });

  it('clearing disabled restores all providers', () => {
    registry.setDisabled(['test-alpha']);
    registry.setDisabled([]);
    expect(registry.isConfigured('test-alpha')).toBe(true);
  });

  it('getProviderForModel skips disabled providers', async () => {
    const provMatch = new TestProvider('test-matcher');
    registry.register(provMatch.getProviderInfo(), provMatch);
    modelRegistry.registerModel('special-model', 'test-matcher', 100, true);

    expect(registry.getProviderForModel('special-model')?.identity.providerId).toBe('test-matcher');

    registry.setDisabled(['test-matcher']);
    expect(registry.getProviderForModel('special-model')).toBeUndefined();
  });
});
