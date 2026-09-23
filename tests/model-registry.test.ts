import { describe, it, expect, beforeEach } from 'vitest';
import { registry } from '../src/providers/registry';
import { modelRegistry } from '../src/lib/model-registry';
import { Provider, ProviderInfo } from '../src/lib/types';
import { providerRefreshCooldown } from '../src/lib/provider-refresh-cooldown';

class TestProvider implements Provider {
  info: ProviderInfo;
  models: string[];
  failDiscovery: boolean;
  constructor(id: string, models: string[] = [], failDiscovery = false) {
    this.info = { providerId: id, providerName: id };
    this.models = models;
    this.failDiscovery = failDiscovery;
  }
  getProviderInfo(): ProviderInfo { return this.info; }
  chatCompletion(_p: any): Promise<any> { return Promise.resolve({}); }
  chatCompletionRaw(_p: any): Promise<string> { return Promise.resolve('{}'); }
  chatCompletionStream(_p: any): Promise<any> { return Promise.resolve({ stream: {}, keyIndex: 0, tag: '' }); }
  async listModels(): Promise<any> {
    if (this.failDiscovery) throw new Error('upstream discovery failed');
    return { object: 'list', data: this.models.map(id => ({ id, object: 'model', owned_by: this.info.providerId })) };
  }
  createEmbedding(_p: any): Promise<any> { return Promise.resolve({}); }
}

const DS_FLASH = 'deepseek-v4-flash';
const DS_PRO = 'deepseek-v4-pro';
const DS_0371 = 'deepseek-v4-flash-0371';

describe('Model Registry - Discovery & Provider Disable', () => {
  beforeEach(() => {
    registry.reset();
    modelRegistry.clear();
    providerRefreshCooldown.reset();
  });

  it('loads models for ALL registered providers, including disabled ones', async () => {
    const provA = new TestProvider('reg-a', [DS_FLASH]);
    const provB = new TestProvider('reg-b', [DS_PRO]);
    registry.register(provA.getProviderInfo(), provA);
    registry.register(provB.getProviderInfo(), provB);

    registry.setDisabled(['reg-b']);

    await modelRegistry.loadFromProviders();

    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBeGreaterThan(0);
    // Disabled provider's models are still KNOWN in the registry:
    expect(modelRegistry.getModelsForProvider('reg-b').length).toBeGreaterThan(0);
    // ...but marked non-routable:
    expect(modelRegistry.getProvidersForModel(DS_PRO).length).toBe(0);
  });

  it('does NOT treat 0 models from one provider as absence of all providers', async () => {
    const provA = new TestProvider('empty-a', []);
    const provB = new TestProvider('ok-b', [DS_FLASH]);
    registry.register(provA.getProviderInfo(), provA);
    registry.register(provB.getProviderInfo(), provB);

    await modelRegistry.loadFromProviders();

    // provider A contributed nothing, but provider B's models are present:
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBeGreaterThan(0);
  });

  it('does NOT crash when discovery throws — other providers still load', async () => {
    const provFail = new TestProvider('fail-a', [DS_FLASH], true);
    const provOk = new TestProvider('ok-b', [DS_PRO]);
    registry.register(provFail.getProviderInfo(), provFail);
    registry.register(provOk.getProviderInfo(), provOk);

    await modelRegistry.loadFromProviders();

    expect(modelRegistry.getProvidersForModel(DS_PRO).length).toBeGreaterThan(0);
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBe(0);
  });

  it('keeps provider + models known after enable/disable cycle', async () => {
    const prov = new TestProvider('cycle-a', [DS_FLASH]);
    registry.register(prov.getProviderInfo(), prov);

    await modelRegistry.loadFromProvider('cycle-a');
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBe(1);

    registry.disableProvider('cycle-a');
    modelRegistry.setAllModelsEnabled('cycle-a', false);
    // Still known, but not routable:
    expect(modelRegistry.getModelsForProvider('cycle-a').length).toBeGreaterThan(0);
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBe(0);

    registry.enableProvider('cycle-a');
    modelRegistry.setAllModelsEnabled('cycle-a', true);
    // Re-enabled, routable again without re-registration:
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBe(1);
  });

  it('persists disabled provider state across "restart" (loadFromProviders after re-register)', async () => {
    const prov = new TestProvider('persist-a', [DS_FLASH]);
    registry.register(prov.getProviderInfo(), prov);
    await modelRegistry.loadFromProvider('persist-a');

    registry.disableProvider('persist-a');
    modelRegistry.setAllModelsEnabled('persist-a', false);

    // Simulate a restart: fresh registry + fresh provider registration with the
    // persisted disabled list still applied.
    modelRegistry.clear();
    const prov2 = new TestProvider('persist-a', [DS_FLASH]);
    registry.register(prov2.getProviderInfo(), prov2);
    registry.setDisabled(registry.getDisabledProviders());
    // A real restart creates a fresh in-memory cooldown registry.
    providerRefreshCooldown.clear('persist-a');

    await modelRegistry.loadFromProviders();

    // Provider still known, models still known but not routable after restart:
    expect(modelRegistry.getModelsForProvider('persist-a').length).toBeGreaterThan(0);
    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBe(0);
  });

  it('DeepSeek model IDs from the static catalog are discovered and routable', async () => {
    const prov = new TestProvider('ds-a', [DS_FLASH, DS_PRO, 'deepseek-r1']);
    registry.register(prov.getProviderInfo(), prov);

    await modelRegistry.loadFromProvider('ds-a');

    expect(modelRegistry.getProvidersForModel(DS_FLASH).length).toBeGreaterThan(0);
    expect(modelRegistry.getProvidersForModel(DS_PRO).length).toBeGreaterThan(0);
    expect(modelRegistry.getProvidersForModel('deepseek-r1').length).toBeGreaterThan(0);
  });

  it('seekai models route EXCLUSIVELY through seekai (no other provider fallback)', async () => {
    const seekProv = new TestProvider('seekai', [
      'deepseek-v4-pro', 'gpt-5-6-luna', 'claude-opus-5', 'claude-fable-5',
    ]);
    const otherProv = new TestProvider('otherp', [
      'deepseek-v4-pro', 'gpt-5-6-luna', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8',
    ]);
    const goroutProv = new TestProvider('gorouter', ['claude-opus-4-8']);
    registry.register(seekProv.getProviderInfo(), seekProv);
    registry.register(otherProv.getProviderInfo(), otherProv);
    registry.register(goroutProv.getProviderInfo(), goroutProv);

    await modelRegistry.loadFromProviders();

    // Every model seekai serves resolves ONLY to seekai.
    for (const m of ['deepseek-v4-pro', 'gpt-5-6-luna', 'claude-opus-5', 'claude-fable-5']) {
      const providers = modelRegistry.getProvidersForModel(m);
      expect(providers.length).toBe(1);
      expect(providers[0].providerId).toBe('seekai');
    }
  });

  it('claude-opus-4-8 routes gorouter-first then seekai (both pinned, others excluded)', async () => {
    const seekProv = new TestProvider('seekai', ['claude-opus-4-8']);
    const otherProv = new TestProvider('otherp', ['claude-opus-4-8']);
    const goroutProv = new TestProvider('gorouter', ['claude-opus-4-8']);
    registry.register(seekProv.getProviderInfo(), seekProv);
    registry.register(otherProv.getProviderInfo(), otherProv);
    registry.register(goroutProv.getProviderInfo(), goroutProv);

    await modelRegistry.loadFromProviders();

    const providers = modelRegistry.getProvidersForModel('claude-opus-4-8');
    expect(providers.map(p => p.providerId)).toEqual(['gorouter', 'seekai']);
  });

  it('empero models route EXCLUSIVELY through empero (no fallback to BAI or others)', async () => {
    const emperoProv = new TestProvider('empero', ['glm-5.3-flash', 'qwen3.8-flash']);
    const baiProv = new TestProvider('bai', ['glm-5.3-flash', 'qwen3.8-flash', 'glm-5.2']);
    const otherProv = new TestProvider('otherp', ['glm-5.3-flash', 'qwen3.8-flash']);
    registry.register(emperoProv.getProviderInfo(), emperoProv);
    registry.register(baiProv.getProviderInfo(), baiProv);
    registry.register(otherProv.getProviderInfo(), otherProv);

    await modelRegistry.loadFromProviders();

    // Every model empero serves resolves ONLY to empero — even though BAI and
    // others advertise the same ids with a HIGHER default priority.
    for (const m of ['glm-5.3-flash', 'qwen3.8-flash']) {
      const providers = modelRegistry.getProvidersForModel(m);
      expect(providers.length).toBe(1);
      expect(providers[0].providerId).toBe('empero');
    }
    // Models empero does NOT serve stay unaffected (BAI's glm-5.2 routes freely).
    const glm52 = modelRegistry.getProvidersForModel('glm-5.2');
    expect(glm52.some(p => p.providerId === 'bai')).toBe(true);
  });

  it('empero exclusivity is dropped for a model empero no longer serves', async () => {
    const emperoProv = new TestProvider('empero', ['glm-5.3-flash']);
    const baiProv = new TestProvider('bai', ['glm-5.3-flash', 'qwen3.8-flash']);
    registry.register(emperoProv.getProviderInfo(), emperoProv);
    registry.register(baiProv.getProviderInfo(), baiProv);

    await modelRegistry.loadFromProviders();
    expect(modelRegistry.getProvidersForModel('glm-5.3-flash')[0].providerId).toBe('empero');

    // Empero no longer serves glm-5.3-flash; exclivity must NOT keep pinning it.
    const emperoProv2 = new TestProvider('empero', []);
    registry.register(emperoProv2.getProviderInfo(), emperoProv2);
    providerRefreshCooldown.clear('empero');
    await modelRegistry.loadFromProvider('empero');

    const providers = modelRegistry.getProvidersForModel('glm-5.3-flash');
    expect(providers.some(p => p.providerId === 'bai')).toBe(true);
  });
});
