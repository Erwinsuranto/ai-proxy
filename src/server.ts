import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { chatRoutes } from './routes/chat';
import { modelRoutes } from './routes/models';
import { embeddingRoutes } from './routes/embeddings';
import { internalRoutes } from './routes/internal';
import { responsesRoutes } from './routes/responses';
import { databricksRoutes } from './routes/databricks';
import { adminRoutes } from './routes/admin';
import { initProvider, getAllKeyManagers, getAllEndpointManagers } from './services/provider';
import { findClientKeyByRaw, touchClientKey } from './lib/client-key-store';
import { scrubClientPayload, toClientError } from './lib/client-sanitize';
import { openAIError } from './utils/openaiResponse';

const isDev = process.env.NODE_ENV !== 'production' && process.env.LOG_LEVEL !== 'silent';

const loggerConfig: Record<string, unknown> = {
  level: config.logLevel,
};

if (isDev) {
  try {
    loggerConfig.transport = {
      target: 'pino-pretty',
      options: { colorize: true },
    };
  } catch {
  }
}

/* Request ids must be unique across server RESTARTS: Fastify's default
 * `req-N` resets to req-1 on every boot, which would make usage records from
 * different generations share the same requestId (ambiguous logs, broken
 * dedup semantics). Prefixing with a per-boot random id keeps ids stable
 * within a process and globally distinct across restarts. */
const BOOT_ID = Math.random().toString(36).slice(2, 10);
let reqSeq = 0;
const app = Fastify({
  logger: loggerConfig,
  genReqId: () => `b${BOOT_ID}-${++reqSeq}`,
});

// ─── Global API key authentication ───────────────────────────────────────
// Credential policy per path family:
//  - /health   → always public (liveness probe only, no internals exposed)
//  - /admin/*  → protected by the admin-scoped hook in routes/admin.ts
//  - /internal/* → master API_KEY only — NEVER reachable with a Client API
//    key (internal ops data such as provider/key/debug state must not be
//    obtainable through the public API surface)
//  - /v1/*     → per-client API keys (Create API Key feature) or the legacy
//    master API_KEY env secret. Client keys are attached to the request so
//    routes can enforce provider/model permissions. Disabled keys are
//    rejected outright.
app.addHook('onRequest', async (request, reply) => {
  const url = request.url;
  if (url.startsWith('/health') || url.startsWith('/admin')) return;

  const auth = request.headers.authorization || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (request.headers['x-api-key'] as string) || '';

  if (url.startsWith('/internal')) {
    if (config.apiKey && supplied !== config.apiKey) {
      return reply.code(401).send({
        error: { message: 'Invalid API key', type: 'auth_error' },
      });
    }
    return;
  }

  if (supplied) {
    const clientKey = findClientKeyByRaw(supplied);
    if (clientKey) {
      if (clientKey.status !== 'active') {
        return reply.code(401).send({
          error: { message: 'API key is disabled', type: 'auth_error' },
        });
      }
      (request as any).clientKey = clientKey;
      touchClientKey(clientKey.id);
      return;
    }
  }

  // Auth is OPTIONAL: when no API_KEY is configured the proxy accepts any
  // request (matches the original pre-auth behavior). When a key IS set,
  // every /v1 request must present it via Bearer or x-api-key.
  if (config.apiKey && supplied !== config.apiKey) {
    return reply.code(401).send({
      error: {
        message: 'Invalid API key',
        type: 'auth_error',
      },
    });
  }
});

// ─── Provider leak guard (global response layer) ─────────────────────────
// Every /v1/* JSON response passes through one scrubber that strips internal
// envelope keys (provider, providerId, upstream*, backend*, baseUrl, stack,
// endpoint, …) no matter which route produced it — including routes added in
// the future. Raw hijacked writes (chat completions) scrub inside routes/chat.ts;
// SSE chunks scrub inside services/stream-usage.ts. Provider info stays
// visible ONLY on /admin/* and /internal/* (admin surfaces).
app.addHook('onSend', async (request, reply, payload) => {
  if (!request.url.startsWith('/v1')) return payload;
  const contentType = reply.getHeader('content-type');
  if (typeof contentType === 'string' && contentType.includes('application/json') && typeof payload === 'string') {
    try {
      return JSON.stringify(scrubClientPayload(JSON.parse(payload)));
    } catch {
      return payload; // non-JSON body — leave untouched
    }
  }
  return payload;
});

/* ─── Global /v1 error boundary (default Fastify error handler override) ────
 * Routes normally catch their own errors, but ANY unhandled throw inside a
 * /v1 handler (or a future route that forgot its try/catch) must never fall
 * through to Fastify's default handler, which would serialize raw error
 * objects — potentially including provider names, upstream URLs, axios
 * response bodies or stack traces — to the client. This boundary replaces
 * every error with a generic OpenAI-compatible envelope (status preserved).
 * Admin/internal surfaces keep their own detailed error handling.
 *
 * ERROR ENVELOPE CONTRACT (must stay consistent with the admin dashboard's
 * `extractApiError` parser):
 *   - /v1/*          → { error: { message, type } }   (OpenAI-style object)
 *   - everything else → { error: "message" }           (plain string)
 * Admin routes return `{ error: "..." }` strings on 4xx; this boundary makes
 * 5xx/404 follow the SAME shape so the UI can always render the message. */
app.setErrorHandler((error: any, request, reply) => {
  if (!request.url.startsWith('/v1')) {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    request.log.error({ requestId: request.id, statusCode: status, err: error }, 'unhandled non-/v1 error');
    if (error?.providerRefreshCooldown) {
      return reply.status(429).send({
        error: error.message,
        providerId: error.providerRefreshCooldown.providerId,
        remainingMs: error.providerRefreshCooldown.remainingMs,
        remainingSeconds: error.providerRefreshCooldown.remainingSeconds,
      });
    }
    return reply.status(status).send({
      error: error.message || 'Internal Server Error',
    });
  }
  request.log.error({ requestId: request.id, statusCode: error.statusCode }, 'unhandled /v1 error');
  const clientErr = toClientError({ status: typeof error.statusCode === 'number' ? error.statusCode : 500 });
  return reply.status(clientErr.status).send(openAIError(clientErr.status, clientErr.message));
});

/* 404s on unknown /v1/* paths: OpenAI-shaped, provider-agnostic. Fastify's
 * default 404 JSON does not leak internals, but a consistent envelope keeps
 * the public API fingerprint uniform. */
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/v1')) {
    return reply.status(404).send(openAIError(404, 'The requested endpoint was not found.'));
  }
  return reply.status(404).send({ error: 'Not found' });
});

app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
});

/* Liveness probe only — intentionally exposes NO provider/routing details. */
app.get('/health', async () => ({
  status: 'ok',
}));

app.register(chatRoutes);
app.register(modelRoutes);
app.register(embeddingRoutes);
app.register(internalRoutes);
app.register(responsesRoutes);
app.register(databricksRoutes);
app.register(adminRoutes);

function refreshAllCooldowns(): void {
  const kms = getAllKeyManagers();
  for (const name of Object.keys(kms)) {
    kms[name].refreshCooldowns();
  }
  const ems = getAllEndpointManagers();
  for (const name of Object.keys(ems)) {
    ems[name].refreshCooldowns();
  }
}

async function start() {
  initProvider();
  /* Per-key 429/balance cooldowns last PROVIDER_COOLDOWN_MS (default 180s);
   * sweep every 60s so expired cooldowns actually release on time instead of
   * lingering until the next 5-minute tick. Cheap in-memory loop. */
  setInterval(() => refreshAllCooldowns(), 60_000);
  await app.listen({ port: config.port, host: config.host });
}

start();
