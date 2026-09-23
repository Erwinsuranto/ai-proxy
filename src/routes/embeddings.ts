import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createEmbedding, runWithClientKeyContext } from '../services/provider';
import { openAIError } from '../utils/openaiResponse';
import { enforceClientKeyModelAccess, getClientKeyContext, resolveComboRequestContext } from '../lib/client-key-guard';
import { runWithComboContext } from '../lib/combo-context';
import { toClientError, scrubClientPayload } from '../lib/client-sanitize';

/** Registers the `/v1/embeddings` route on the Fastify instance. */
export async function embeddingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/embeddings', async (request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const body = request.body as any;
    const model = body.model ?? 'unknown';
    const requestId = request.id as string;

    if (!body.model) {
      return reply.status(400).send(openAIError(400, 'model is required'));
    }
    if (!body.input) {
      return reply.status(400).send(openAIError(400, 'input is required'));
    }

    /* Per-client API key permissions (see routes/chat.ts). Returns the
     * effective (de-prefixed) model to route; null when access is denied. */
    const effectiveModel = enforceClientKeyModelAccess(request, reply, body.model);
    if (effectiveModel === null) {
      return reply;
    }

    /* COMBO: pin the request to the active combo (if any) for this client
     * key + model — provider-locked routing for the whole embedding call. */
    const comboCtx = resolveComboRequestContext(request, effectiveModel);

    try {
      const nvidiaPayload: Record<string, any> = {
        model: effectiveModel,
        input: body.input,
      };
      if (body.encoding_format) {
        nvidiaPayload.encoding_format = body.encoding_format;
      }

      /* Attribute usage to the client key AND keep the COMBO routing pin
       * active for the whole embedding call. */
      const data = await runWithClientKeyContext(
        () => runWithComboContext(
          () => createEmbedding(nvidiaPayload, requestId),
          comboCtx,
        ),
        getClientKeyContext(request),
      );

      /* Provider leak guard: the upstream embedding body may carry internal
       * envelope keys — strip them, and normalize `model` to what the CLIENT
       * requested (never the internal backend model). */
      const safeData = scrubClientPayload(data);
      if (safeData && typeof safeData === 'object') {
        safeData.model = model;
      }

      request.log.info({
        requestId,
        model,
        latency: Date.now() - start,
        status: 200,
      }, 'embedding');

      return reply.send(safeData);
    } catch (error: any) {
      request.log.error({
        requestId,
        model,
        latency: Date.now() - start,
        status: error.status ?? 500,
        error: error.message,
      }, 'embedding error');

      const clientErr = toClientError(error);
      return reply.status(clientErr.status).send(openAIError(clientErr.status, clientErr.message));
    }
  });
}
