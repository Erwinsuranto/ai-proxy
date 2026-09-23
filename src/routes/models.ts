import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { listModels } from '../services/provider';
import { resolveModelAlias } from '../services/alias-resolver';
import { config } from '../config';
import { getClientKey } from '../lib/client-key-guard';
import { listActiveComboModels } from '../lib/combo-store';

/** The gateway's own public identity for `owned_by` — clients must never see
 *  which internal provider serves a model (or the upstream's own owner tag). */
const GATEWAY_OWNER = 'nvidia-api';

function normalizeModelEntry(m: any): any {
  return {
    id: m?.id,
    object: 'model',
    created: typeof m?.created === 'number' ? m.created : Math.floor(Date.now() / 1000),
    owned_by: GATEWAY_OWNER,
  };
}

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const requestId = request.id as string;

    try {
      const allModels = await listModels();

      if (allModels?.data) {
        /* Per-client API keys only see their own provider's allowed models —
         * never another provider's catalog. The effective catalog is the key's
         * allowedModels UNION the models granted by its ACTIVE combos (a
         * combo is an additional authorization source). No provider
         * identity, upstream URL or credential is ever exposed here. */
        const clientKey = getClientKey(request);
        let data = allModels.data;
        if (clientKey) {
          const allowed = new Set(clientKey.allowedModels);
          for (const model of listActiveComboModels(clientKey.id)) {
            allowed.add(model);
          }
          data = data.filter((m: any) => allowed.has(m?.id));
        }

        request.log.info({
          requestId,
          latency: Date.now() - start,
          status: 200,
        }, 'list models');

        /* Normalized envelope: whitelisted fields only, provider identity
         * replaced by the gateway's own (no providerId / upstream owner). */
        return reply.send({
          object: 'list',
          data: data.map(normalizeModelEntry),
        });
      }
    } catch (e) {
      request.log.warn({ requestId, latency: Date.now() - start, error: (e as any)?.message }, 'failed to fetch models, using alias fallback');
    }

    const aliasModels = resolveModelAlias(config.modelAlias) ?? [config.modelAlias];
    const fallbackModels = aliasModels.map((id: string) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: GATEWAY_OWNER,
    }));

    return reply.send({
      object: 'list',
      data: fallbackModels,
    });
  });
}
