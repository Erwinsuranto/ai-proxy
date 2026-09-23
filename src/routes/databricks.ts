import { FastifyInstance } from 'fastify';
import { getDatabricksProvider, virtualRouter } from '../services/provider';
import { registry } from '../providers/registry';

export function databricksRoutes(app: FastifyInstance, _opts: any, done: () => void): void {
  app.get('/internal/databricks/models', async (_request, reply) => {
    const provider = getDatabricksProvider();
    if (!provider) {
      return reply.status(404).send({ error: 'Databricks provider not configured' });
    }

    const registry = provider.getModelRegistry();
    const summaries = registry.getAllEndpointSummaries();
    const result = summaries.map((s) => ({
      endpoint: s.endpointName,
      healthy: s.healthy,
      models: registry.getAllModels().filter((m) => registry.getModelEndpoints(m).includes(s.endpointIndex)),
    }));

    return reply.send(result);
  });

  app.get('/internal/databricks/aliases', async (_request, reply) => {
    const provider = getDatabricksProvider();
    if (!provider) {
      return reply.status(404).send({ error: 'Databricks provider not configured' });
    }

    const aliasMap = provider.getVirtualAliasMap();
    const obj: Record<string, string> = {};
    for (const [k, v] of aliasMap) {
      obj[k] = v;
    }
    return reply.send(obj);
  });

  app.get('/internal/databricks/model-map', async (_request, reply) => {
    const provider = getDatabricksProvider();
    if (!provider) {
      return reply.status(404).send({ error: 'Databricks provider not configured' });
    }

    const aliasMap = provider.getModelAliasMap();
    const obj: Record<string, string> = {};
    for (const [k, v] of aliasMap) {
      obj[k] = v;
    }
    return reply.send(obj);
  });

  app.get('/internal/virtual-routes', async (_request, reply) => {
    const models = virtualRouter.getAllVirtualModels();
    const result = models.map((vm) => {
      const config = virtualRouter.getRouteConfig(vm);
      const health = virtualRouter.getBackendHealth(vm);
      return {
        virtualModel: vm,
        strategy: config?.strategy,
        backends: config?.backends.map((b, i) => ({
          provider: b.provider,
          upstreamModel: b.model,
          healthy: health?.[i]?.disabledUntil === null || (health?.[i]?.disabledUntil ?? 0) < Date.now(),
          successCount: health?.[i]?.successCount ?? 0,
          failureCount: health?.[i]?.failureCount ?? 0,
          averageLatency: health?.[i]?.averageLatency ?? 0,
          lastError: health?.[i]?.lastError,
        })),
      };
    });
    return reply.send(result);
  });

  app.get('/internal/providers', async (_request, reply) => {
    const all = registry.getAllProviders();
    const enabled = registry.getEnabledProviderIds();
    const disabled = registry.getDisabledProviders();
    return reply.send({
      enabled: all.filter(p => enabled.includes(p.identity.providerId)).map(p => p.identity.providerId),
      disabled,
    });
  });

  app.get('/internal/databricks/endpoints', async (_request, reply) => {
    const provider = getDatabricksProvider();
    if (!provider) {
      return reply.status(404).send({ error: 'Databricks provider not configured' });
    }

    const em = provider.getEndpointManager();
    const registry = provider.getModelRegistry();
    const stats = em.getStats();
    const result = stats.map((s) => ({
      ...s,
      modelCount: registry.getEndpointModelCount(s.id - 1),
    }));

    return reply.send(result);
  });

  done();
}
