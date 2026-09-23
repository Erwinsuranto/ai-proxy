import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Transform } from 'stream';
import { chatCompletionRaw, chatCompletionStream, runWithClientKeyContext } from '../services/provider';
import { openAIError, createDoneChunk } from '../utils/openaiResponse';
import { config } from '../config';
import { enforceClientKeyModelAccess, getClientKeyContext, getClientKey, resolveComboRequestContext } from '../lib/client-key-guard';
import { runWithComboContext } from '../lib/combo-context';
import { runWithInferenceSession, extractInferenceSessionId } from '../lib/inference-session';
import { toClientError, scrubClientPayload } from '../lib/client-sanitize';

const DEBUG_TC = process.env.DEBUG_TOOL_CALL === 'true';

/* SSE keepalive: some upstreams (e.g. thinking models) pause tens of seconds
 * between chunks; strict SSE clients abort with "read timed out" on silence.
 * A periodic SSE comment (ignored per spec) resets the client's read timer.
 * 0 disables. */
const SSE_KEEPALIVE_MS = (() => {
  const raw = Number(process.env.SSE_KEEPALIVE_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 15_000;
})();

function debugLog(label: string, data: any): void {
  if (!DEBUG_TC) return;
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const maxLen = 2000;
  const truncated = str.length > maxLen ? str.slice(0, maxLen) + '\n... [truncated]' : str;
  process.stderr.write(`\n[DEBUG_TOOL_CALL] ${label}\n${truncated}\n`);
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const body = request.body as any;
    const model = body.model ?? 'unknown';
    const requestId = request.id as string;

    if (!body.model) {
      return reply.status(400).send(openAIError(400, 'model is required'));
    }
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.status(400).send(openAIError(400, 'messages must be a non-empty array'));
    }

    /* Per-client API key permissions: the requested model must be in the
     * key's allowlist. The key's bound provider stays INTERNAL — prefixed
     * models are normalized to their base id so a client key cannot probe
     * which provider it maps to (all prefixes behave identically). */
    const effectiveModel = enforceClientKeyModelAccess(request, reply, body.model);
    if (effectiveModel === null) {
      return reply;
    }
    if (getClientKey(request)) {
      body.model = effectiveModel;
    }

    /* COMBO: resolve the active combo for this client key + model BEFORE the
     * request lifecycle starts. When present, every provider/key decision in
     * the routing pipeline is pinned to the combo (provider-locked, no
     * cross-provider fallback). Null → normal routing policy. */
    const comboCtx = resolveComboRequestContext(request, effectiveModel);

    try {
      const providerPayload = { ...body, max_tokens: body.max_tokens ?? config.defaultMaxTokens };
      console.log(`[ROUTE_CHAT] Model=${model}`);

      if (DEBUG_TC) {
        debugLog('REQUEST BODY', providerPayload);
      }

      const keyCtx = getClientKeyContext(request);
      /* OpenCode Inference session identity: carry ONLY the client-supplied
       * `x-opencode-session` through the request lifecycle so the
       * opencode-inference provider can forward it upstream. Never generated,
       * never logged, never read from credentials. Every other provider ignores
       * this context entirely. */
      const inferenceSession = extractInferenceSessionId(request.headers as Record<string, any>);
      const execute = async (): Promise<void> => {
      if (body.stream) {
        const result = await chatCompletionStream(providerPayload, requestId);
        const nvidiaStream = result.stream;

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Request-Id': requestId,
        });

        if (DEBUG_TC) {
          let chunkCount = 0;
          nvidiaStream.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            if (text.includes('tool_calls')) {
              debugLog(`STREAM CHUNK #${chunkCount}`, text);
            }
            chunkCount++;
          });
        }

        let sawDone = false;
        let tail = '';
        const output = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const text = chunk.toString();
            tail = (tail + text).slice(-64);
            if (tail.includes('data: [DONE]')) {
              sawDone = true;
            }
            callback(null, chunk);
          },
        });

        let streamFinished = false;
        function safeEnd(): void {
          if (streamFinished) return;
          streamFinished = true;
          if (reply.raw.destroyed || reply.raw.writableEnded) return;
          try {
            if (!sawDone) {
              reply.raw.write(createDoneChunk());
            }
            reply.raw.end();
          } catch {
            // reply closed concurrently
          }
        }

        nvidiaStream.pipe(output);
        output.pipe(reply.raw, { end: false });
        output.on('end', safeEnd);

        let lastWrite = Date.now();
        output.on('data', () => { lastWrite = Date.now(); });
        let keepalive: ReturnType<typeof setInterval> | null = null;
        if (SSE_KEEPALIVE_MS > 0) {
          keepalive = setInterval(() => {
            if (streamFinished || reply.raw.destroyed || reply.raw.writableEnded) return;
            if (Date.now() - lastWrite >= SSE_KEEPALIVE_MS) {
              try {
                output.write(': keepalive\n\n');
                lastWrite = Date.now();
              } catch { /* client gone */ }
            }
          }, Math.min(SSE_KEEPALIVE_MS, 5000));
          keepalive.unref?.();
        }
        const stopKeepalive = () => { if (keepalive) { clearInterval(keepalive); keepalive = null; } };
        output.on('end', stopKeepalive);
        output.on('error', stopKeepalive);

        nvidiaStream.on('error', (err: Error) => {
          request.log.error({ requestId, latency: Date.now() - start, error: err.message }, 'stream error');
          if (streamFinished) return;
          streamFinished = true;
          if (reply.raw.destroyed) return;
          /* Client-facing stream errors are generic — never the upstream's
           * own error text (provider name / URL / body could leak). */
          const clientErr = toClientError(err as any);
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(clientErr.status, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify(openAIError(clientErr.status, clientErr.message)));
          } else if (!reply.raw.writableEnded) {
            try {
              reply.raw.write(createDoneChunk());
            } catch {
              // reply closed concurrently
            }
            reply.raw.end();
          }
        });

        request.raw.on('close', () => {
          if (!streamFinished) {
            streamFinished = true;
          }
          if (!nvidiaStream.destroyed) {
            nvidiaStream.destroy();
          }
        });
      } else {
        const response = await chatCompletionRaw(providerPayload, requestId);

        let parsedBody: any;
        try {
          parsedBody = JSON.parse(response);
        } catch {
          parsedBody = undefined;
        }

        /* Upstream returned a non-JSON body (HTML/WAF page/plain text error).
         * NEVER forward it verbatim — it can embed hostnames, paths, WAF
         * branding or stack traces. Surface a generic 502 instead. */
        if (!parsedBody || typeof parsedBody !== 'object') {
          request.log.error({
            requestId,
            model,
            latency: Date.now() - start,
            status: 502,
          }, 'upstream returned a non-JSON body');
          reply.hijack();
          reply.raw.writeHead(502, {
            'Content-Type': 'application/json',
            'X-Request-Id': requestId,
          });
          reply.raw.end(JSON.stringify(openAIError(502, 'Upstream provider request failed.')));
          return;
        }

        if (DEBUG_TC) {
          const hasToolCalls = parsedBody?.choices?.some((c: any) => c.message?.tool_calls || c.message?.function_call);
          if (hasToolCalls) {
            debugLog('RESPONSE BODY', parsedBody);
          }
        }

        /* Normalization + provider leak guard:
         *  - `model` reports what the CLIENT requested (never the internal
         *    backend model actually routed upstream);
         *  - internal envelope keys (provider, upstream*, backend*, base*,
         *    stack, endpoint, …) are stripped deeply. Model content is
         *    never rewritten. */
        if ('model' in parsedBody) {
          parsedBody.model = model;
        }
        const scrubbed = scrubClientPayload(parsedBody);
        const responseBody = JSON.stringify(scrubbed);

        request.log.info({
          requestId,
          model,
          latency: Date.now() - start,
          status: 200,
        }, 'chat completion');

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        });
        reply.raw.end(responseBody);
      }
      };

      /* Attribute every usage record from this lifecycle (incl. deferred
       * stream 'end' callbacks) to the client key that made the request, and
       * keep the COMBO routing pin active for the whole lifecycle. */
      await runWithClientKeyContext(
        () => runWithComboContext(
          () => runWithInferenceSession(execute, inferenceSession),
          comboCtx,
        ),
        keyCtx,
      );
    } catch (error: any) {
      request.log.error({
        requestId,
        model,
        latency: Date.now() - start,
        status: error.status ?? 500,
        error: error.message,
      }, 'chat completion error');

      /* Provider leak guard: only gateway-crafted (clientSafe) messages reach
       * the client verbatim; anything from upstream is genericized. */
      const clientErr = toClientError(error);
      return reply.status(clientErr.status).send(openAIError(clientErr.status, clientErr.message));
    }
  });
}
