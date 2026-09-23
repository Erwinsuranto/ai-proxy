import { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { getAllKeyManagers, getAllEndpointManagers, getPrimaryProviderId, getInferXHealth, getOneHopHealth, getOrcaRouterHealth, getSeekAIHealth, getHCNSecHealth, getTeamoRouterHealth, getGroqHealth, getKiloHealth, getZenHealth, getInferenceHealth, getLogfareHealth, getEmperoHealth, getAgentRouterHealth, getTokenHarborHealth, getCodeCraftApiHealth, getClineHealth, getDahlHealth, getTabiTokenHealth, getBaiHealth, getHashNeuronHealth, getUnliHealth, getLlm7Health, getBazaarLinkHealth, getDeepBricksHealth, getFreebuffHealth, getVyceAIHealth, getTokenRouterHealth, getHuggingFaceHealth, getGmiHealth, getXkiroHealth, getFlatKeyHealth, getAisurplusHealth, getKiosapiHealth, getNusapiHealth, getExperientialLabsHealth, getCodepusHealth, getKieHealth, getTokenForgeHealth, getAtriaHealth, getHiveHealth, getApmixHealth, getInvibuilderHealth, getInceptionHealth, getJijiHealth } from '../services/provider';
import { modelRegistry } from '../lib/model-registry';
import { registry } from '../providers/registry';
import { discoveryStore } from '../lib/discovery';

const startTime = Date.now();

/** Real application version from package.json (read once, no hardcoding). */
const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export function internalRoutes(app: FastifyInstance, _opts: any, done: () => void): void {
  app.get('/internal/keys', async (_request, reply) => {
    const kms = getAllKeyManagers();
    const ems = getAllEndpointManagers();
    const allStats: any[] = [];
    for (const providerName of Object.keys(kms)) {
      const stats = kms[providerName].getStats();
      for (const s of stats) {
        allStats.push({ ...s, provider: providerName });
      }
    }
    for (const providerName of Object.keys(ems)) {
      const stats = ems[providerName].getStats();
      for (const s of stats) {
        allStats.push({ ...s, provider: providerName });
      }
    }
    return reply.send(allStats);
  });

  app.get('/internal/health', async (_request, reply) => {
    const kms = getAllKeyManagers();
    const ems = getAllEndpointManagers();
    const providers: any[] = [];
    let totalKeys = 0;
    let totalActiveKeys = 0;
    let totalCooldownKeys = 0;
    let totalRequests = 0;

    for (const name of Object.keys(kms)) {
      const h = kms[name].health();
      providers.push({ provider: name, ...h });
      totalKeys += h.totalKeys;
      totalActiveKeys += h.activeKeys;
      totalCooldownKeys += h.cooldownKeys;
      totalRequests += h.requests;
    }
    for (const name of Object.keys(ems)) {
      const h = ems[name].health();
      providers.push({ provider: name, ...h });
      totalKeys += h.totalEndpoints;
      totalActiveKeys += h.activeEndpoints;
      totalCooldownKeys += h.cooldownEndpoints;
      totalRequests += h.requests;
    }

    return reply.send({
      provider: getPrimaryProviderId(),
      providers,
      discovery: discoveryStore.getAllStates(),
      totalKeys,
      activeKeys: totalActiveKeys,
      cooldownKeys: totalCooldownKeys,
      requests: totalRequests,
      uptime: Date.now() - startTime,
      version: APP_VERSION,
    });
  });

  app.get('/internal/health/inferx', async (_request, reply) => {
    const health = await getInferXHealth();
    if (!health) {
      return reply.status(404).send({ error: 'InferX provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/onehop', async (_request, reply) => {
    const health = await getOneHopHealth();
    if (!health) {
      return reply.status(404).send({ error: 'OneHop provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/orcarouter', async (_request, reply) => {
    const health = await getOrcaRouterHealth();
    if (!health) {
      return reply.status(404).send({ error: 'OrcaRouter provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/seekai', async (_request, reply) => {
    const health = await getSeekAIHealth();
    if (!health) {
      return reply.status(404).send({ error: 'SeekAI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/hcnsec', async (_request, reply) => {
    const health = await getHCNSecHealth();
    if (!health) {
      return reply.status(404).send({ error: 'HCNSec provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/teamorouter', async (_request, reply) => {
    const health = await getTeamoRouterHealth();
    if (!health) {
      return reply.status(404).send({ error: 'TeamoRouter provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/groq', async (_request, reply) => {
    const health = await getGroqHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Groq provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/kilo', async (_request, reply) => {
    const health = await getKiloHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Kilo Gateway provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/zen', async (_request, reply) => {
    const health = await getZenHealth();
    if (!health) {
      return reply.status(404).send({ error: 'OpenCode Zen provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/opencode-inference', async (_request, reply) => {
    const health = await getInferenceHealth();
    if (!health) {
      return reply.status(404).send({ error: 'OpenCode Inference provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/logfare', async (_request, reply) => {
    const health = await getLogfareHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Logfare provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/empero', async (_request, reply) => {
    const health = await getEmperoHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Empero provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/agentrouter', async (_request, reply) => {
    const health = await getAgentRouterHealth();
    if (!health) {
      return reply.status(404).send({ error: 'AgentRouter provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/tokenharbor', async (_request, reply) => {
    const health = await getTokenHarborHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Token Harbor provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/cline', async (_request, reply) => {
    const health = await getClineHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Cline provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/codecraftapi', async (_request, reply) => {
    const health = await getCodeCraftApiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'CodeCraft API provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/dahl', async (_request, reply) => {
    const health = await getDahlHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Dahl provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/tabitoken', async (_request, reply) => {
    const health = await getTabiTokenHealth();
    if (!health) {
      return reply.status(404).send({ error: 'TabiToken provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/bai', async (_request, reply) => {
    const health = await getBaiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'BAI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/hashneuron', async (_request, reply) => {
    const health = await getHashNeuronHealth();
    if (!health) {
      return reply.status(404).send({ error: 'HashNeuron provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/vyceai', async (_request, reply) => {
    const health = await getVyceAIHealth();
    if (!health) {
      return reply.status(404).send({ error: 'VyceAI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/tokenrouter', async (_request, reply) => {
    const health = await getTokenRouterHealth();
    if (!health) {
      return reply.status(404).send({ error: 'TokenRouter provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/unli', async (_request, reply) => {
    const health = await getUnliHealth();
    if (!health) {
      return reply.status(404).send({ error: 'UNLI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/llm7', async (_request, reply) => {
    const health = await getLlm7Health();
    if (!health) {
      return reply.status(404).send({ error: 'LLM7 provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/bazaarlink', async (_request, reply) => {
    const health = await getBazaarLinkHealth();
    if (!health) {
      return reply.status(404).send({ error: 'BazaarLink provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/deepbricks', async (_request, reply) => {
    const health = await getDeepBricksHealth();
    if (!health) {
      return reply.status(404).send({ error: 'DeepBricks provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/freebuff', async (_request, reply) => {
    const health = await getFreebuffHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Freebuff provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/huggingface', async (_request, reply) => {
    const health = await getHuggingFaceHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Hugging Face provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/gmi', async (_request, reply) => {
    const health = await getGmiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'GMI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/xkiro', async (_request, reply) => {
    const health = await getXkiroHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Xkiro provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/flatkey', async (_request, reply) => {
    const health = await getFlatKeyHealth();
    if (!health) {
      return reply.status(404).send({ error: 'FlatKey provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/aisurplus', async (_request, reply) => {
    const health = await getAisurplusHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Aisurplus provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/kiosapi', async (_request, reply) => {
    const health = await getKiosapiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'KiosAPI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/nusapi', async (_request, reply) => {
    const health = await getNusapiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'NusAPI provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/experientiallabs', async (_request, reply) => {
    const health = await getExperientialLabsHealth();
    if (!health) {
      return reply.status(404).send({ error: 'ExperientialLabs provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/codepus', async (_request, reply) => {
    const health = await getCodepusHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Codepus provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/kie.ai', async (_request, reply) => {
    const health = await getKieHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Kie.ai provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/tokenforge', async (_request, reply) => {
    const health = await getTokenForgeHealth();
    if (!health) {
      return reply.status(404).send({ error: 'TokenForge provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/atria', async (_request, reply) => {
    const health = await getAtriaHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Atria provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/hive', async (_request, reply) => {
    const health = await getHiveHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Hive provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/apmix', async (_request, reply) => {
    const health = await getApmixHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Apmix provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/invibuilder', async (_request, reply) => {
    const health = await getInvibuilderHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Invibuilder provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/inception', async (_request, reply) => {
    const health = await getInceptionHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Inception provider is not configured' });
    }
    return reply.send(health);
  });

  app.get('/internal/health/jiji', async (_request, reply) => {
    const health = await getJijiHealth();
    if (!health) {
      return reply.status(404).send({ error: 'Jiji provider is not configured' });
    }
    return reply.send(health);
  });

  // Debug: dump the resolved model registry (what routing actually sees).
  // Shows client-facing id, its de-prefixed alias, the upstream backend model,
  // the origin provider, and the wire protocol/endpoint chosen per model.
  // Optional ?provider=agentrouter and ?refresh=1 (force re-discovery first).
  app.get('/internal/debug/models', async (request, reply) => {
    const q = request.query as { provider?: string; refresh?: string };

    if (q.refresh === '1' || q.refresh === 'true') {
      try {
        if (q.provider) {
          await modelRegistry.loadFromProvider(q.provider);
        } else {
          await modelRegistry.loadFromProviders();
        }
      } catch (error: any) {
        const cooldown = error?.providerRefreshCooldown;
        if (cooldown) {
          return reply.status(429).send({
            error: error.message,
            providerId: cooldown.providerId,
            remainingMs: cooldown.remainingMs,
            remainingSeconds: cooldown.remainingSeconds,
          });
        }
        throw error;
      }
    }

    const entries = modelRegistry.getAllEntries()
      .filter((e) => !q.provider || e.providerId === q.provider)
      .map((e) => {
        const isAlias = !!e.backendModel && e.backendModel !== e.model;
        return {
          provider: e.providerId,
          model: e.model,
          alias: isAlias ? e.model : null,
          backendModel: e.backendModel ?? e.model,
          protocol: e.protocol ?? 'openai',
          endpoint: e.endpoint ?? null,
          enabled: e.enabled,
          priority: e.priority,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

    const byProvider: Record<string, number> = {};
    for (const e of entries) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;

    const claude = entries.filter((e) => /claude/i.test(e.model) || /claude/i.test(e.backendModel));

    return reply.send({
      configuredProviders: registry.getAllProviderIds(),
      totalEntries: entries.length,
      countsByProvider: byProvider,
      claudeCount: claude.length,
      claudeModels: claude.map((c) => ({ provider: c.provider, model: c.model, backendModel: c.backendModel, protocol: c.protocol })),
      models: entries,
    });
  });

  // Debug: per-provider discovery status (WAF detection, health, cache age).
  // Answers "why does this provider have no/stale models?" at a glance.
  app.get('/internal/debug/providers', async (_request, reply) => {
    const configured = registry.getAllProviderIds();
    const states = discoveryStore.getAllStates();
    const stateByProvider = new Map(states.map((s) => [s.provider, s]));

    const rows = configured.map((provider) => {
      const s = stateByProvider.get(provider);
      const modelCount = modelRegistry.getModelsForProvider(provider).length;
      return {
        provider,
        status: s?.status ?? 'degraded',
        reason: s?.reason ?? 'no discovery attempted yet',
        modelCount,
        cachedModels: s?.cachedModels ?? 0,
        modelsDiscovered: s?.modelsDiscovered ?? 0,
        lastDiscovery: s?.lastDiscovery ?? null,
        lastSuccess: s?.lastSuccess ?? null,
        blockedByWAF: s?.blockedByWAF ?? false,
        contentType: s?.contentType ?? null,
        httpStatus: s?.httpStatus ?? null,
        responseBytes: s?.responseBytes ?? 0,
        responseTime: s?.responseTime ?? 0,
      };
    });

    return reply.send({
      configuredProviders: configured,
      providers: rows,
    });
  });

  done();
}
