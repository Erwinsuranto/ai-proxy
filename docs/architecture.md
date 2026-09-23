# Architecture

## Overview

This proxy translates OpenAI-compatible API calls to either NVIDIA NIM API or Cloudflare Workers AI API calls. It sits between your application and the upstream provider, providing seamless integration without requiring application changes.

## Provider Selection

The proxy is **multi-provider**: providers are registered at startup in `src/providers/registry.ts` and exposed to requests through the **Model Registry** (`src/lib/model-registry.ts`). Each provider is activated when its credentials are configured (e.g. `NVIDIA_API_KEY`, `TOKENHARBOR_API_KEY_1..5`, `OPENROUTER_API_KEY`). A request is routed to the first enabled provider that supports the requested model, with priority ordering. New providers are added through code (a provider implementation + registry registration + env credentials) — there is no dynamic "Add Provider" UI; the admin surface only lists/toggles providers (see `docs/configuration.md`).

| Provider | Module |
|----------|--------|
| NVIDIA NIM | `src/providers/nvidia/` |
| TokenHarbor.ai | `src/providers/tokenharbor/` |
| Other registered providers | `src/providers/*/` |

The `src/services/provider.ts` module acts as a unified facade, routing each request to the correct provider implementation.

## Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT                                     │
│              baseURL: http://localhost:3000/v1                     │
│              apiKey:  any-value (ignored by proxy)                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP/SSE
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API PROXY (Fastify 5)                            │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Route Layer                                                 │  │
│  │  ┌─────────────────┐ ┌────────────────┐ ┌────────────────┐  │  │
│  │  │ /v1/chat/        │ │ /v1/embeddings  │ │ /v1/models     │  │  │
│  │  │ completions      │ │                 │ │                │  │  │
│  │  ├─────────────────┤ ├────────────────┤ ├────────────────┤  │  │
│  │  │ /v1/responses    │ │ /internal/keys  │ │ /internal/     │  │  │
│  │  │ (Responses API)  │ │ /health         │ │ health         │  │  │
│  │  └────────┬────────┘ └────────┬───────┘ └────────────────┘  │  │
│  └───────────┼───────────────────┼──────────────────────────────┘  │
│              ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Provider Selector (src/services/provider.ts)                │  │
│  │  • Routes to NVIDIA or Cloudflare based on env config        │  │
│  │  • Unified interface: chat, embeddings, models, streams     │  │
│  └──────────┬──────────────────────────────────┬───────────────┘  │
│             ▼                                  ▼                   │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │  NVIDIA Provider         │  │  Cloudflare Provider          │   │
│  │  (src/lib/provider.ts)   │  │  (src/lib/cloudflare-         │   │
│  │  • Axios HTTP client     │  │   provider.ts)                │   │
│  │  • Key rotation & retry  │  │  • Axios HTTP client          │   │
│  │  • SSE passthrough       │  │  • Model name mapping         │   │
│  └──────────┬──────────────┘  │  • Retry with backoff          │   │
│             │                 │  • SSE with model transform    │   │
│  ┌──────────▼──────────────┐  └──────────┬───────────────────┘   │
│  │  Key Manager             │             │                       │
│  │  (src/lib/key-          │             │                       │
│  │   manager.ts)            │             │                       │
│  │  • Round-robin           │             │                       │
│  │  • Cooldown on 429       │             │                       │
│  │  • Per-key stats         │             │                       │
│  └──────────────────────────┘             │                       │
└──────────────────────┬────────────────────┼───────────────────────┘
                       │                    │
                       ▼                    ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  NVIDIA NIM API           │  │  Cloudflare Workers AI       │
│  integrate.api.nvidia.com │  │  api.cloudflare.com          │
│  /v1                      │  │  /client/v4/accounts/...     │
│                           │  │                              │
│  Key #1 ───► Round Robin  │  │  Single token                │
│  Key #2 ───► Distribution │  │  Retry on 429/5xx            │
│  Key #N ───► Failover     │  │                              │
└──────────────────────────┘  └──────────────────────────────┘
```

## Key Design Decisions

### Stateless Proxy
The proxy maintains no persistent state beyond in-memory key statistics. No database, no file storage. This makes it horizontally scalable — each instance independently manages its key state.

### Multi-Provider via Interface
All providers implement the `Provider` interface (`src/lib/types.ts`), making it straightforward to add new backends:
- Define a class implementing the 5 provider methods
- Add auto-detection logic in `src/services/provider.ts`
- Done

### Promise-based Lock Chain (NVIDIA)
Key selection uses a Promise-based lock chain (`withLock` in `key-manager.ts:35`) rather than traditional mutexes. This ensures async-safe round-robin without blocking the event loop.

### Transparent Streaming
SSE streams from the upstream provider are piped directly to the client via Node.js streams (`providerStream.pipe(reply.raw)`). No buffering means minimal latency overhead.

### Model Name Mapping (Cloudflare)
The Cloudflare provider translates user-friendly model names to Cloudflare model IDs before sending requests, and reverse-maps the model name in responses so clients always see the original name.

### Responses API Bridge
The `/v1/responses` endpoint converts between OpenAI's newer Responses API format and the standard chat completions format using Transform streams (`src/utils/responses.ts`).

### Error Classification
`src/lib/retry.ts` classifies errors by HTTP status and message keywords to determine retry eligibility and quota violations. Both providers reuse this module.

## Data Flow

### Non-streaming Request
1. Client sends POST request → route handler
2. Route validates required fields (model, messages/input)
3. `services/provider.ts` selects the active provider
4. Provider calls upstream API (NVIDIA or Cloudflare)
5. Response transformed to OpenAI format → logged → sent to client

### Streaming Request
1-3. Same as non-streaming
4. Provider makes streaming request (responseType: 'stream')
5. SSE stream piped directly to client response
6. On client disconnect: stream destroyed immediately
7. On upstream error: error event sent, stream ended

### Key Failover (NVIDIA)
1. Provider selects Key #1
2. Request fails with 429 (rate limit)
3. Key #1 marked cooldown (60s)
4. Provider retries with Key #2 (round-robin)
5. If all keys exhausted: 429 returned to client

### Retry (Cloudflare)
1. Provider sends request with Cloudflare API token
2. On 429: wait with exponential backoff (1s, 2s, 4s), then retry
3. On 5xx: retry immediately
4. After 3 attempts: error returned to client
