import { describe, it, expect, beforeEach } from 'vitest';
import { modelRegistry } from '../src/lib/model-registry';

function logRoute(requestedModel: string, matched: { providerId: string; priority: number }[], selected: string | null, reason: string): void {
  console.log('\n========================================');
  console.log(`Requested Model:     ${requestedModel}`);
  console.log(`Matched Providers:   ${matched.length > 0 ? matched.map(m => `${m.providerId}(p=${m.priority})`).join(', ') : '(none)'}`);
  console.log(`Selected Provider:   ${selected ?? '(none)'}`);
  console.log(`Selected API Key:    (round-robin within provider)`);
  console.log(`Reason:              ${reason}`);
  console.log('========================================\n');
}

describe('Provider Routing Integration', () => {
  beforeEach(() => {
    modelRegistry.clear();
  });

  it('Scenario 1: deepseek-v4-flash -> NVIDIA (priority lebih tinggi)', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    const selected = providers[0] ?? null;

    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      selected?.providerId ?? null,
      'NVIDIA priority=1 < ZEN priority=2 → NVIDIA selected as primary',
    );

    expect(providers.length).toBe(2);
    expect(selected?.providerId).toBe('nvidia');
    expect(selected?.priority).toBe(1);
    expect(providers[1].providerId).toBe('zen');
    expect(providers[1].priority).toBe(2);
  });

  it('Scenario 2: deepseek-v4-flash -> ZEN (setelah NVIDIA dimatikan)', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    modelRegistry.setEnabled('deepseek-v4-flash', 'nvidia', false);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    const selected = providers[0] ?? null;

    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      selected?.providerId ?? null,
      'NVIDIA disabled → skip NVIDIA → ZEN selected as primary',
    );

    expect(providers.length).toBe(1);
    expect(selected?.providerId).toBe('zen');
    expect(selected?.priority).toBe(2);
    expect(modelRegistry.hasModel('deepseek-v4-flash', 'nvidia')).toBe(false);
  });

  it('Scenario 3: deepseek-v4-flash-free -> ZEN (hanya ZEN yang punya)', () => {
    modelRegistry.registerModel('deepseek-v4-flash-free', 'zen', 1);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash-free');
    const selected = providers[0] ?? null;

    logRoute(
      'deepseek-v4-flash-free',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      selected?.providerId ?? null,
      'Hanya ZEN yang memiliki model deepseek-v4-flash-free → langsung ZEN',
    );

    expect(providers.length).toBe(1);
    expect(selected?.providerId).toBe('zen');
    expect(modelRegistry.hasModel('deepseek-v4-flash-free', 'nvidia')).toBe(false);
  });

  it('Scenario 4: @cf/openai/gpt-oss-120b -> Cloudflare (hanya Cloudflare yang punya)', () => {
    modelRegistry.registerModel('@cf/openai/gpt-oss-120b', 'cloudflare', 1);

    const providers = modelRegistry.getProvidersForModel('@cf/openai/gpt-oss-120b');
    const selected = providers[0] ?? null;

    logRoute(
      '@cf/openai/gpt-oss-120b',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      selected?.providerId ?? null,
      'Hanya Cloudflare yang memiliki model @cf/openai/gpt-oss-120b → langsung Cloudflare',
    );

    expect(providers.length).toBe(1);
    expect(selected?.providerId).toBe('cloudflare');
    expect(modelRegistry.hasModel('@cf/openai/gpt-oss-120b', 'nvidia')).toBe(false);
    expect(modelRegistry.hasModel('@cf/openai/gpt-oss-120b', 'zen')).toBe(false);
  });

  it('Scenario 5: glm-5.2 -> Databricks (hanya Databricks yang punya)', () => {
    modelRegistry.registerModel('glm-5.2', 'databricks', 1);

    const providers = modelRegistry.getProvidersForModel('glm-5.2');
    const selected = providers[0] ?? null;

    logRoute(
      'glm-5.2',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      selected?.providerId ?? null,
      'Hanya Databricks yang memiliki model glm-5.2 → langsung Databricks',
    );

    expect(providers.length).toBe(1);
    expect(selected?.providerId).toBe('databricks');
    expect(modelRegistry.hasModel('glm-5.2', 'nvidia')).toBe(false);
    expect(modelRegistry.hasModel('glm-5.2', 'zen')).toBe(false);
  });

  it('Scenario 6: model tidak dikenal -> error, tidak ada provider yang dipilih', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash-free', 'zen', 1);
    modelRegistry.registerModel('@cf/openai/gpt-oss-120b', 'cloudflare', 1);
    modelRegistry.registerModel('glm-5.2', 'databricks', 1);

    const unknownModel = 'model-tidak-ada-v99';
    const providers = modelRegistry.getProvidersForModel(unknownModel);
    const selected = providers[0] ?? null;

    logRoute(
      unknownModel,
      [],
      null,
      'Model tidak terdaftar di ModelRegistry → tidak ada provider yang cocok → error 400',
    );

    expect(providers.length).toBe(0);
    expect(selected).toBeNull();
    expect(modelRegistry.hasModel(unknownModel, 'nvidia')).toBe(false);
    expect(modelRegistry.hasModel(unknownModel, 'zen')).toBe(false);
    expect(modelRegistry.hasModel(unknownModel, 'cloudflare')).toBe(false);
    expect(modelRegistry.hasModel(unknownModel, 'databricks')).toBe(false);
  });

  it('Scenario 7: failover otomatis antar provider yang memiliki model sama (NVIDIA->ZEN)', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');

    expect(providers.length).toBe(2);
    expect(providers[0].providerId).toBe('nvidia');
    expect(providers[1].providerId).toBe('zen');

    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      'nvidia (failover ke zen jika gagal)',
      'NVIDIA primary, ZEN sebagai failover — Round Robin hanya untuk API Key di dalam provider',
    );
  });

  it('Scenario 8: priority bisa diubah kapan saja tanpa restart', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    let providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    expect(providers[0].providerId).toBe('nvidia');

    modelRegistry.setPriority('deepseek-v4-flash', 'zen', 1);
    modelRegistry.setPriority('deepseek-v4-flash', 'nvidia', 2);

    providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    expect(providers[0].providerId).toBe('zen');
    expect(providers[0].priority).toBe(1);
    expect(providers[1].providerId).toBe('nvidia');
    expect(providers[1].priority).toBe(2);

    logRoute(
      'deepseek-v4-flash (priority diubah)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Priority ZEN diubah ke 1, NVIDIA ke 2 → ZEN sekarang primary tanpa restart',
    );
  });

  it('Scenario 9: Admin tambah model langsung berlaku tanpa restart', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);

    expect(modelRegistry.hasModel('deepseek-v4-flash', 'nvidia')).toBe(true);
    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(1);

    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(2);
    expect(modelRegistry.hasModel('deepseek-v4-flash', 'zen')).toBe(true);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    logRoute(
      'deepseek-v4-flash (ZEN baru ditambahkan)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Setelah admin menambah ZEN via POST /admin/models, routing langsung membaca mapping baru',
    );
  });

  it('Scenario 10: Admin hapus model langsung berlaku tanpa restart', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(2);

    modelRegistry.removeModel('deepseek-v4-flash', 'zen');

    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(1);
    expect(modelRegistry.hasModel('deepseek-v4-flash', 'zen')).toBe(false);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    logRoute(
      'deepseek-v4-flash (ZEN dihapus)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Setelah admin menghapus ZEN via DELETE /admin/models, routing hanya melihat NVIDIA',
    );
  });

  it('Scenario 11: dua provider dengan priority sama -> urutan registrasi', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 100);
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 100);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    // priority sama → diurutkan berdasarkan prioritas (sama) → urutan dalam array
    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Priority sama (100) → kedua provider valid, dipilih sesuai urutan array (ZEN dulu karena diregistrasi duluan)',
    );

    expect(providers.length).toBe(2);
  });

  it('Scenario 12: enable/disable model provider via admin langsung berlaku', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-v4-flash', 'zen', 2);

    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(2);

    modelRegistry.setEnabled('deepseek-v4-flash', 'nvidia', false);
    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(1);
    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash')[0].providerId).toBe('zen');

    modelRegistry.setEnabled('deepseek-v4-flash', 'nvidia', true);
    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash').length).toBe(2);
    expect(modelRegistry.getProvidersForModel('deepseek-v4-flash')[0].providerId).toBe('nvidia');

    logRoute(
      'deepseek-v4-flash (NVIDIA dinonaktifkan lalu diaktifkan)',
      modelRegistry.getProvidersForModel('deepseek-v4-flash').map(p => ({ providerId: p.providerId, priority: p.priority })),
      'nvidia',
      'setEnabled langsung mempengaruhi routing tanpa restart',
    );
  });

  it('Scenario 13: alias deepseek-ai/deepseek-v4-flash -> deepseek-v4-flash', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerAlias('deepseek-ai/deepseek-v4-flash', 'deepseek-v4-flash');

    const resolved = modelRegistry.resolveAlias('deepseek-ai/deepseek-v4-flash');
    expect(resolved).toBe('deepseek-v4-flash');

    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');
    expect(providers.length).toBe(1);
    expect(providers[0].providerId).toBe('nvidia');
    expect(providers[0].model).toBe('deepseek-v4-flash');
    expect(modelRegistry.hasModel('deepseek-ai/deepseek-v4-flash', 'nvidia')).toBe(true);

    logRoute(
      'deepseek-ai/deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Alias deepseek-ai/deepseek-v4-flash → deepseek-v4-flash → NVIDIA dipilih',
    );
  });

  it('Scenario 14: alias hanya untuk lookup, model upstream tetap nama registry', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerAlias('deepseek-ai/deepseek-v4-flash', 'deepseek-v4-flash');

    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');
    expect(providers.length).toBe(1);
    expect(providers[0].model).toBe('deepseek-v4-flash');

    const regs = modelRegistry.getModelsForProvider('nvidia');
    expect(regs.some(r => r.model === 'deepseek-v4-flash')).toBe(true);
    expect(regs.some(r => r.model === 'deepseek-ai/deepseek-v4-flash')).toBe(false);

    logRoute(
      'deepseek-ai/deepseek-v4-flash (alias)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Alias hanya dipakai lookup; upstream model tetap deepseek-v4-flash (nama registry)',
    );
  });

  it('Scenario 15: hapus alias -> tetap match via namespace-tolerant lookup (base name)', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerAlias('deepseek-ai/deepseek-v4-flash', 'deepseek-v4-flash');

    expect(modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash').length).toBe(1);

    modelRegistry.removeAlias('deepseek-ai/deepseek-v4-flash');

    // Even without the explicit alias, the org-prefixed request
    // "deepseek-ai/deepseek-v4-flash" now resolves to NVIDIA's "deepseek-v4-flash"
    // because lookup matches on the base name (portion after the first "/").
    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');
    expect(providers.length).toBe(1);
    expect(providers[0].providerId).toBe('nvidia');
    expect(providers[0].model).toBe('deepseek-v4-flash');
    // resolveAlias still returns the input unchanged once the alias is gone.
    expect(modelRegistry.resolveAlias('deepseek-ai/deepseek-v4-flash')).toBe('deepseek-ai/deepseek-v4-flash');

    logRoute(
      'deepseek-ai/deepseek-v4-flash (alias dihapus)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Alias dihapus, namun namespace-tolerant lookup mencocokkan base name → NVIDIA tetap terpilih',
    );
  });

  it('Scenario 16: getAliases mengembalikan semua alias terdaftar', () => {
    modelRegistry.registerAlias('deepseek-ai/deepseek-v4-flash', 'deepseek-v4-flash');
    modelRegistry.registerAlias('deepseek-ai/deepseek-v4-pro', 'deepseek-v4-pro');

    const aliases = modelRegistry.getAliases();
    expect(aliases.length).toBe(2);
    expect(aliases).toContainEqual({ alias: 'deepseek-ai/deepseek-v4-flash', target: 'deepseek-v4-flash' });
    expect(aliases).toContainEqual({ alias: 'deepseek-ai/deepseek-v4-pro', target: 'deepseek-v4-pro' });
  });

  it('Scenario 17: backendModel per provider — client model dipertahankan, upstream memakai backendModel', () => {
    modelRegistry.registerModel('deepseek-ai/deepseek-v4-flash', 'nvidia', 1);
    modelRegistry.registerModel('deepseek-ai/deepseek-v4-flash', 'zen', 2, true, 'deepseek-v4-flash-free');

    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');
    expect(providers.length).toBe(2);
    expect(providers[0].providerId).toBe('nvidia');
    expect(providers[1].providerId).toBe('zen');

    const zenBackend = modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'zen');
    expect(zenBackend).toBe('deepseek-v4-flash-free');

    const nvidiaBackend = modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'nvidia');
    expect(nvidiaBackend).toBeUndefined();

    logRoute(
      'deepseek-ai/deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'NVIDIA primary (tanpa backendModel → pakai client model), ZEN failover (backendModel=deepseek-v4-flash-free)',
    );

    expect(providers[1].model).toBe('deepseek-ai/deepseek-v4-flash');
  });

  it('Scenario 18: backendModel default ke model client jika tidak diset', () => {
    modelRegistry.registerModel('deepseek-ai/deepseek-v4-flash', 'nvidia', 1);

    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');
    expect(providers.length).toBe(1);
    expect(providers[0].providerId).toBe('nvidia');
    expect(modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'nvidia')).toBeUndefined();

    logRoute(
      'deepseek-ai/deepseek-v4-flash (tanpa backendModel)',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0].providerId,
      'Tanpa backendModel, upstream memakai client model apa adanya',
    );
  });

  it('Scenario 19: setBackendModel dapat diubah/dibersihkan tanpa restart', () => {
    modelRegistry.registerModel('deepseek-ai/deepseek-v4-flash', 'zen', 2, true, 'deepseek-v4-flash-free');
    expect(modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'zen')).toBe('deepseek-v4-flash-free');

    modelRegistry.setBackendModel('deepseek-ai/deepseek-v4-flash', 'zen', 'deepseek-v4-flash');
    expect(modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'zen')).toBe('deepseek-v4-flash');

    modelRegistry.setBackendModel('deepseek-ai/deepseek-v4-flash', 'zen', null);
    expect(modelRegistry.getBackendModel('deepseek-ai/deepseek-v4-flash', 'zen')).toBeUndefined();

    logRoute(
      'deepseek-ai/deepseek-v4-flash (backendModel diubah)',
      modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash').map(p => ({ providerId: p.providerId, priority: p.priority })),
      'zen',
      'PATCH /admin/models/:providerId/:encodedModel memperbarui backendModel langsung berlaku',
    );
  });

  it('Scenario 20: BUG FIX — request "deepseek-ai/deepseek-v4-flash" harus ke NVIDIA, OpenRouter hanya fallback', () => {
    // Replicate production model-registry loading order + priorities:
    // OpenRouter registered first (priority 100), NVIDIA after (priority 50).
    // NVIDIA exposes the model unprefixed ("deepseek-v4-flash") while the client
    // requests the canonical org-prefixed id ("deepseek-ai/deepseek-v4-flash").
    modelRegistry.registerModel('deepseek-v4-flash', 'openrouter', 100);
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 50);

    const providers = modelRegistry.getProvidersForModel('deepseek-ai/deepseek-v4-flash');

    logRoute(
      'deepseek-ai/deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0]?.providerId ?? null,
      'NVIDIA (priority=50) mendukung model via base-name match → dipilih; OpenRouter (priority=100) hanya fallback',
    );

    expect(providers.length).toBe(2);
    expect(providers[0].providerId).toBe('nvidia');
    expect(providers[0].model).toBe('deepseek-v4-flash');
    expect(providers[1].providerId).toBe('openrouter');
  });

  it('Scenario 21: prioritas NVIDIA > GoRouter > OpenRouter untuk model yang sama', () => {
    // Replicate production priorities: nvidia=50, gorouter=75, openrouter=100.
    // Registration order is intentionally reversed to prove ordering is decided
    // by priority, not insertion order.
    modelRegistry.registerModel('deepseek-v4-flash', 'openrouter', 100);
    modelRegistry.registerModel('deepseek-v4-flash', 'gorouter', 75);
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 50);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');

    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0]?.providerId ?? null,
      'NVIDIA(50) → GoRouter(75) → OpenRouter(100); OpenRouter hanya dipakai jika dua provider sebelumnya gagal',
    );

    expect(providers.map(p => p.providerId)).toEqual(['nvidia', 'gorouter', 'openrouter']);
  });

  it('Scenario 22: GoRouter dipilih saat NVIDIA tidak mendukung model', () => {
    modelRegistry.registerModel('some-gorouter-only-model', 'gorouter', 75);
    modelRegistry.registerModel('some-gorouter-only-model', 'openrouter', 100);

    const providers = modelRegistry.getProvidersForModel('some-gorouter-only-model');

    logRoute(
      'some-gorouter-only-model',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0]?.providerId ?? null,
      'NVIDIA tidak punya model → GoRouter primary, OpenRouter fallback',
    );

    expect(providers.map(p => p.providerId)).toEqual(['gorouter', 'openrouter']);
  });

  it('Scenario 23: prioritas NVIDIA > InferX > GoRouter > OpenRouter untuk model yang sama', () => {
    // Replicate production priorities: nvidia=50, inferx=70, gorouter=75, openrouter=100.
    modelRegistry.registerModel('deepseek-v4-flash', 'openrouter', 100);
    modelRegistry.registerModel('deepseek-v4-flash', 'gorouter', 75);
    modelRegistry.registerModel('deepseek-v4-flash', 'inferx', 70);
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 50);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');

    logRoute(
      'deepseek-v4-flash',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0]?.providerId ?? null,
      'NVIDIA(50) → InferX(70) → GoRouter(75) → OpenRouter(100)',
    );

    expect(providers.map(p => p.providerId)).toEqual(['nvidia', 'inferx', 'gorouter', 'openrouter']);
  });

  it('Scenario 24: InferX dipilih saat NVIDIA tidak mendukung model', () => {
    modelRegistry.registerModel('some-inferx-only-model', 'inferx', 70);
    modelRegistry.registerModel('some-inferx-only-model', 'gorouter', 75);
    modelRegistry.registerModel('some-inferx-only-model', 'openrouter', 100);

    const providers = modelRegistry.getProvidersForModel('some-inferx-only-model');

    logRoute(
      'some-inferx-only-model',
      providers.map(p => ({ providerId: p.providerId, priority: p.priority })),
      providers[0]?.providerId ?? null,
      'NVIDIA tidak punya model → InferX primary, GoRouter & OpenRouter fallback',
    );

    expect(providers.map(p => p.providerId)).toEqual(['inferx', 'gorouter', 'openrouter']);
  });
});

describe('Case-insensitive model matching', () => {
  beforeEach(() => {
    modelRegistry.clear();
  });

  it('registers mixed-case upstream ids and resolves any casing, keeping the canonical backend id', () => {
    // Simulates an HCNSec /v1/models response with mixed-case model ids.
    modelRegistry.registerModel('DeepSeek-V4-Pro', 'hcnsec', 95);
    modelRegistry.registerModel('glm-5.2', 'hcnsec', 95);

    const lower = modelRegistry.getProvidersForModel('deepseek-v4-pro');
    const upper = modelRegistry.getProvidersForModel('DEEPSEEK-V4-PRO');
    const original = modelRegistry.getProvidersForModel('DeepSeek-V4-Pro');
    const glm = modelRegistry.getProvidersForModel('GLM-5.2');

    expect(lower.map(p => p.providerId)).toEqual(['hcnsec']);
    expect(lower[0].backendModel ?? lower[0].model).toBe('DeepSeek-V4-Pro');
    expect(upper.map(p => p.providerId)).toEqual(['hcnsec']);
    expect(original.map(p => p.providerId)).toEqual(['hcnsec']);
    expect(glm.map(p => p.providerId)).toEqual(['hcnsec']);
    expect(modelRegistry.getBackendModel('deepseek-v4-pro', 'hcnsec')).toBe('DeepSeek-V4-Pro');
    expect(modelRegistry.hasModel('DEEPSEEK-V4-PRO', 'hcnsec')).toBe(true);
  });

  it('does not change behavior for already-lowercase model ids', () => {
    modelRegistry.registerModel('deepseek-v4-flash', 'nvidia', 50);

    const providers = modelRegistry.getProvidersForModel('deepseek-v4-flash');
    expect(providers.map(p => p.providerId)).toEqual(['nvidia']);
    expect(providers[0].model).toBe('deepseek-v4-flash');
    expect(providers[0].backendModel ?? providers[0].model).toBe('deepseek-v4-flash');
  });
});
