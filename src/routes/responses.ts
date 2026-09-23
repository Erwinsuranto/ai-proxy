import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { chatCompletion, chatCompletionStream, runWithClientKeyContext } from '../services/provider';
import { openAIError } from '../utils/openaiResponse';
import { convertToChatRequest, convertFromChatResponse, createResponsesStream } from '../utils/responses';
import { enforceClientKeyModelAccess, getClientKeyContext, resolveComboRequestContext } from '../lib/client-key-guard';
import { runWithComboContext } from '../lib/combo-context';
import { runWithInferenceSession, extractInferenceSessionId } from '../lib/inference-session';
import { toClientError, scrubClientPayload } from '../lib/client-sanitize';

/** Registers the `/v1/responses` route (both streaming and non-streaming) on the Fastify instance. */
export async function responsesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const body = request.body as any;
    const requestId = request.id as string;

    if (!body.model) {
      return reply.status(400).send(openAIError(400, 'model is required'));
    }
    if (!body.input) {
      return reply.status(400).send(openAIError(400, 'input is required'));
    }

    /* Per-client API key permissions (see routes/chat.ts). The chat payload
     * routes with the effective (de-prefixed) model; the CLIENT-visible model
     * everywhere in the response is always the originally requested one. */
    const effectiveModel = enforceClientKeyModelAccess(request, reply, body.model);
    if (effectiveModel === null) {
      return reply;
    }

    /* COMBO: pin the request to the active combo (if any) for this client
     * key + model — provider-locked routing for the whole lifecycle. */
    const comboCtx = resolveComboRequestContext(request, effectiveModel);

    try {
      const chatPayload = convertToChatRequest(body);
      chatPayload.model = effectiveModel;
      console.log(`[ROUTE_RESPONSES] Model=${chatPayload.model}`);

      /* OpenCode Inference session identity (see routes/chat.ts). Only the
       * client-supplied `x-opencode-session` is carried; never generated. */
      const inferenceSession = extractInferenceSessionId(request.headers as Record<string, any>);

      if (body.stream) {
        const result = await runWithClientKeyContext(
          () => runWithComboContext(
            () => runWithInferenceSession(
              () => chatCompletionStream(chatPayload, requestId),
              inferenceSession,
            ),
            comboCtx,
          ),
          getClientKeyContext(request),
        );
        const nvidiaStream = result.stream;

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Request-Id': requestId,
        });

        const responseId = `resp-${Date.now()}`;
        const transform = createResponsesStream(
          responseId,
          chatPayload.model,
          Math.floor(Date.now() / 1000),
        );

        let streamFinished = false;
        function safeEnd(): void {
          if (streamFinished) return;
          streamFinished = true;
          if (!reply.raw.destroyed && !reply.raw.writableEnded) {
            reply.raw.end();
          }
        }

        nvidiaStream.pipe(transform);
        transform.pipe(reply.raw, { end: false });

        nvidiaStream.on('error', (err: Error) => {
          request.log.error({ requestId, latency: Date.now() - start, error: err.message }, 'responses stream error');
          if (streamFinished) return;
          streamFinished = true;
          if (reply.raw.destroyed) return;
          const clientErr = toClientError(err as any);
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(clientErr.status, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify(openAIError(clientErr.status, clientErr.message)));
          } else if (!reply.raw.writableEnded) {
            try {
              const finalEvent = `event: response.done\ndata: ${JSON.stringify({ id: responseId, object: 'response', status: 'failed' })}\n\n`;
              reply.raw.write(finalEvent);
            } catch {
              // ignore
            }
            reply.raw.end();
          }
        });

        transform.on('error', (err: Error) => {
          request.log.error({ requestId, latency: Date.now() - start, error: err.message }, 'responses transform error');
          if (streamFinished) return;
          streamFinished = true;
          if (reply.raw.destroyed) return;
          const clientErr = toClientError(err as any);
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(clientErr.status, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify(openAIError(clientErr.status, clientErr.message)));
          } else if (!reply.raw.writableEnded) {
            try {
              reply.raw.end();
            } catch {
              // ignore
            }
          }
        });

        transform.on('finish', safeEnd);

        request.raw.on('close', () => {
          if (!streamFinished) {
            streamFinished = true;
          }
          if (!nvidiaStream.destroyed) {
            nvidiaStream.destroy();
          }
          if (!transform.destroyed) {
            transform.destroy();
          }
        });
      } else {
        const data = await runWithClientKeyContext(
          () => runWithComboContext(
            () => runWithInferenceSession(
              () => chatCompletion(chatPayload, requestId),
              inferenceSession,
            ),
            comboCtx,
          ),
          getClientKeyContext(request),
        );

        request.log.info({
          requestId,
          model: body.model,
          latency: Date.now() - start,
          status: 200,
        }, 'responses completion');

        /* Provider leak guard: strip internal envelope keys the upstream may
         * have attached to the chat completion body. */
        const respBody = convertFromChatResponse(scrubClientPayload(data), body);

        return reply.send(respBody);
      }
    } catch (error: any) {
      request.log.error({
        requestId,
        model: body.model,
        latency: Date.now() - start,
        status: error.status ?? 500,
        error: error.message,
      }, 'responses error');

      const clientErr = toClientError(error);
      return reply.status(clientErr.status).send(openAIError(clientErr.status, clientErr.message));
    }
  });
}
