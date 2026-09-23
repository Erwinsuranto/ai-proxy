# API Proxy

**OpenAI-compatible multi-provider proxy supporting NVIDIA NIM, OpenRouter, StepFun, GLM, Cloudflare, GoRouter, InferX, OneHop, SeekAI, HCNSec, AgentRouter, and Databricks**

[![MIT License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify)](https://fastify.dev/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/)

Use any OpenAI SDK, library, or tool -- just change the `baseURL`.
**No code changes required.**

---

## Description

A lightweight, production-ready HTTP proxy that translates OpenAI API calls into multiple backend providers: NVIDIA NIM, OpenRouter, StepFun, GLM (Zhipu AI), Cloudflare Workers AI, GoRouter, InferX, OneHop, SeekAI, HCNSec, AgentRouter, and Databricks. Provides transparent multi-key management with round-robin distribution, automatic retry and failover, per-key cooldown handling, and comprehensive monitoring -- all while maintaining full compatibility with the OpenAI SDK ecosystem.

---

## Features

- **OpenAI-Compatible API** -- Drop-in replacement for any OpenAI SDK, library, or tool
- **Multi-Provider** -- NVIDIA NIM, OpenRouter, StepFun, GLM (Zhipu AI), Cloudflare Workers AI, GoRouter, InferX, OneHop, SeekAI, HCNSec, AgentRouter, Databricks
- **Multi-Key Management** -- Configure 1 to 100+ API keys per provider (NVIDIA, OpenRouter, StepFun, GLM, GoRouter, InferX, OneHop, SeekAI, AgentRouter, Databricks)
- **Round-Robin Distribution** -- Requests spread evenly across all active keys per provider
- **Automatic Retry & Failover** -- Retries on 401, 403, 429, 5xx, timeouts, and network errors; transparent failover to next key
- **Cooldown Management** -- 60s cooldown on rate-limited keys with automatic recovery
- **Model Mapping (Cloudflare)** -- Friendly model names mapped to Cloudflare model IDs
- **Streaming (SSE)** -- Full support for `stream: true` with OpenAI-compatible SSE chunks
- **Responses API** -- OpenAI Responses API `/v1/responses` bridge to chat completions
- **Per-Key Statistics** -- Track requests, successes, failures, latency per key
- **Health Endpoints** -- `/health`, `/internal/health`, `/internal/keys` for monitoring
- **Docker Support** -- Multi-stage Dockerfile + docker-compose for production
- **PM2 Ready** -- Process management with PM2 ecosystem
- **TypeScript** -- Full type safety with strict mode

---

## Architecture

```mermaid
flowchart TD
    Client["Client App
OpenAI SDK / curl / UI"] -->|HTTP / SSE| Fastify["Fastify Router
/v1/chat/completions
/v1/embeddings
/v1/models
/v1/responses"]

    Fastify --> ModelRegistry["Model Registry
Model → Provider mapping
Priority + Enabled"]

    ModelRegistry --> Providers["Provider Layer
Round Robin + Retry + Failover"]

    Providers --> Nvidia["NVIDIA NIM"]
    Providers --> OpenRouter["OpenRouter"]
    Providers --> StepFun["StepFun"]
    Providers --> GLM["GLM (Zhipu AI)"]
    Providers --> Cloudflare["Cloudflare"]
    Providers --> GoRouter["GoRouter"]
    Providers --> InferX["InferX"]
    Providers --> OneHop["OneHop"]
    Providers --> SeekAI["SeekAI"]
    Providers --> HCNSec["HCNSec"]
    Providers --> AgentRouter["AgentRouter"]
    Providers --> Databricks["Databricks"]

    Nvidia -->|SSE / JSON| Fastify
    OpenRouter -->|SSE / JSON| Fastify
    StepFun -->|SSE / JSON| Fastify
    GLM -->|SSE / JSON| Fastify
    Cloudflare -->|SSE / JSON| Fastify
    GoRouter -->|SSE / JSON| Fastify
    InferX -->|SSE / JSON| Fastify
    SeekAI -->|SSE / JSON| Fastify
    HCNSec -->|SSE / JSON| Fastify
    Databricks -->|SSE / JSON| Fastify

    Fastify --> Client

    style Client fill:#e1f5fe,stroke:#0288d1
    style Fastify fill:#f3e5f5,stroke:#7b1fa2
    style ModelRegistry fill:#e8eaf6,stroke:#3949ab
    style Providers fill:#fff8e1,stroke:#f9a825
    style Nvidia fill:#e8f5e9,stroke:#388e3c
    style OpenRouter fill:#e8eaf6,stroke:#3949ab
    style StepFun fill:#fff3e0,stroke:#f57c00
    style GLM fill:#fce4ec,stroke:#c62828
    style Cloudflare fill:#fff3e0,stroke:#f57c00
    style Databricks fill:#e8f5e9,stroke:#388e3c
```

---

## Installation

### Prerequisites

- **Node.js** 20.x or later
- **npm** 9.x or later
- **API Key** from at least one supported provider (NVIDIA, OpenRouter, StepFun, GLM, Cloudflare, GoRouter, InferX, OneHop, SeekAI, HCNSec, AgentRouter, or Databricks)

### Quick Start

```bash
git clone https://github.com/your-username/nvidia-api.git
cd nvidia-api
cp .env.example .env
npm install
```

Edit `.env` and add your API key(s) for any provider you want to use.

---

## Using Aider

Aider is an AI-powered coding assistant that can use this proxy as its API backend. It provides automated code generation, refactoring, bug fixing, and codebase analysis through natural language prompts.

### Installation

Aider requires Python 3.10+ and is installed via pip.

```bash
# Create a dedicated virtual environment
python3 -m venv /root/.venv/aider

# Activate it
source /root/.venv/aider/bin/activate

# Install Aider
pip install aider-chat
```

### Activate Virtual Environment

Before each session, activate the Aider virtual environment:

```bash
source /root/.venv/aider/bin/activate
```

Verify it is active:

```bash
which aider
```

Expected output: `/root/.venv/aider/bin/aider`

### Start the Proxy

Aider communicates with the proxy, so ensure it is running first:

```bash
cd ~/nvidia-api
npm run dev
```

Or for production:

```bash
npm start
```

### Available Models

All models are accessed through the proxy's `openai/` prefix. The following custom metadata files provide Aider with token limits and capabilities:

- `.aider.model.metadata.json` -- token limits, provider, feature flags
- `.aider.model.settings.yml` -- edit format, weak model, repo map settings

| Model | Context | Output | Use Case |
|-------|---------|--------|----------|
| `openai/z-ai/glm-5.2` | 262,144 | 16,384 | Complex reasoning, large context |
| `openai/deepseek-ai/deepseek-v4-flash` | 128,000 | 8,192 | Fast code generation |
| `openai/deepseek-ai/deepseek-v4-pro` | 128,000 | 8,192 | High-quality code review |
| `openai/minimaxai/minimax-m2.7` | 128,000 | 8,192 | General purpose |
| `openai/mistralai/mistral-medium-3.5-128b` | 128,000 | 8,192 | High-quality outputs |

### Running Each Supported Model

Run Aider with any of the following commands. The proxy automatically routes requests to the appropriate provider.

```bash
aider --model openai/z-ai/glm-5.2
```

```bash
aider --model openai/deepseek-ai/deepseek-v4-flash
```

```bash
aider --model openai/deepseek-ai/deepseek-v4-pro
```

```bash
aider --model openai/minimaxai/minimax-m2.7
```

```bash
aider --model openai/mistralai/mistral-medium-3.5-128b
```

### Auditing the Repository

Run Aider with an audit-focused prompt to analyze the entire codebase:

```bash
aider --model openai/z-ai/glm-5.2
```

Then provide the following prompt inside the Aider session:

```
Audit the entire codebase for:
- Security vulnerabilities (hardcoded secrets, injection risks)
- Memory leaks (unclosed streams, event listeners)
- Race conditions (shared state without synchronization)
- Error handling gaps (uncaught promise rejections, missing try/catch)
- Performance bottlenecks (blocking operations, unnecessary allocations)
- Dead code and duplication (unused exports, repeated patterns)
- TypeScript type safety (excessive `any` usage, missing types)
- Logging completeness (missing request/error logging)
```

### Adding Files to Chat

Add specific files or directories to the Aider session for targeted analysis:

```
/add src/lib/provider.ts
/add src/lib/key-manager.ts
/add src/routes/chat.ts
```

Or add the entire source tree:

```
/add src/
```

### Example Prompts

**Audit a specific module:**

```
/src/lib/key-manager.ts
Review the thread-safety of the withLock implementation.
Are there any race conditions in the round-robin logic?
```

**Fix a bug:**

```
/src/routes/chat.ts
The stream error handler does not always send a valid
error response when the headers have already been sent.
Fix this to ensure the client always receives a proper
error or done event.
```

**Refactor code:**

```
/src/lib/provider.ts
The retry loop is duplicated across chatCompletion,
chatCompletionRaw, chatCompletionStream, and createEmbedding.
Extract the common retry logic into a shared helper method.
```

**Add a feature:**

```
/src/routes/internal.ts
Add a new endpoint GET /internal/config that returns
the current configuration (with API keys masked).
```

**Review documentation:**

```
/docs/
Review all markdown files for consistency, accuracy,
and completeness. Suggest improvements.
```

### Troubleshooting

**`aider: command not found`**

The virtual environment is not activated or Aider is not installed.

```bash
source /root/.venv/aider/bin/activate
pip install aider-chat
```

**`Unknown model` warning**

Aider does not include built-in metadata for these models. The custom metadata files (`.aider.model.metadata.json` and `.aider.model.settings.yml`) in the project root provide the necessary token limits and capabilities. Aider automatically discovers these files from the current directory.

**Token limit errors**

Ensure `.aider.model.metadata.json` contains accurate `max_input_tokens` and `max_output_tokens` values:

```bash
grep -n "openai/" .aider.model.metadata.json
```

**Metadata not loaded**

Verify the metadata files exist and are correctly formatted:

```bash
grep -n "name:" .aider.model.settings.yml
```

**Virtual environment not activated**

```bash
source /root/.venv/aider/bin/activate
```

**Proxy offline**

Ensure the proxy is running and reachable:

```bash
curl http://localhost:3000/health
```

**PM2 process stopped**

If running via PM2, check and restart the process:

```bash
pm2 status
pm2 logs nvidia-api --lines 20
pm2 restart nvidia-api
```

### Exit Aider

To exit an Aider session cleanly:

```
/exit
```

Or press `Ctrl+C` to interrupt the current operation and return to the shell.

---

## Using OpenCode

[OpenCode](https://opencode.ai) is an AI coding agent that can use this proxy as its API backend via its OpenAI-compatible provider support.

### Start the Proxy

Ensure the proxy is running first:

```bash
cd ~/nvidia-api
npm start
```

Or with PM2 (production):

```bash
pm2 start dist/server.js --name nvidia-api
```

The proxy listens on `http://localhost:3000` by default.

### OpenCode Config

Add the proxy as a custom provider in your OpenCode config file at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "nvidia-api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA API Proxy",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "sk-no-key-required"
      },
      "models": {
        "tokenharbor/kimi-k3": {
          "name": "Kimi K3 (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/kimi-k3:free": {
          "name": "Kimi K3 Free (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/gpt-5.6-sol": {
          "name": "GPT-5.6 Sol (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/gpt-5.6-terra": {
          "name": "GPT-5.6 Terra (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/gpt-5.6-luna": {
          "name": "GPT-5.6 Luna (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/deepseek-v4-flash:free": {
          "name": "DeepSeek V4 Flash Free (TokenHarbor)",
          "reasoning": true
        },
        "tokenharbor/deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro (TokenHarbor)",
          "reasoning": true
        },
        "zen/laguna-s-2.1-free": {
          "name": "Laguna S 2.1 Free (Zen)",
          "reasoning": false
        },
        "zen/nemotron-3-ultra-free": {
          "name": "Nemotron 3 Ultra Free (Zen)",
          "reasoning": true
        }
      }
    }
  }
}
```

### Model Naming

Models use the proxy's provider-prefixed routing format: `<provider>/<model-id>`.

| Model | Provider Backend | Cost |
|-------|-----------------|------|
| `tokenharbor/kimi-k3` | TokenHarbor | Paid |
| `tokenharbor/kimi-k3:free` | TokenHarbor | Free |
| `tokenharbor/gpt-5.6-sol` | TokenHarbor | Paid |
| `tokenharbor/gpt-5.6-terra` | TokenHarbor | Paid |
| `tokenharbor/gpt-5.6-luna` | TokenHarbor | Paid |
| `tokenharbor/deepseek-v4-flash:free` | TokenHarbor | Free |
| `tokenharbor/deepseek-v4-pro` | TokenHarbor | Paid |
| `zen/laguna-s-2.1-free` | OpenCode Zen | Free |
| `zen/nemotron-3-ultra-free` | OpenCode Zen | Free |

### Selecting the Model in OpenCode

After saving the config, **quit and restart OpenCode** (config is not hot-reloaded), then select the model:

```
/model nvidia-api/tokenharbor/kimi-k3
```

Or set it as the default in `opencode.json`:

```json
{
  "model": "nvidia-api/tokenharbor/kimi-k3"
}
```

### Notes

- The proxy does not require an API key from clients by default, so `apiKey` can be any placeholder string (the OpenCode provider requires the field to be present).
- Any model listed by `GET http://localhost:3000/v1/models` can be added to the `models` map using its full prefixed ID.
- Free-tier models (`:free` / `-free` suffixes) have usage quotas enforced by the upstream provider; paid models require the corresponding provider key in the proxy's `.env`.

---

## Configuration

All configuration is via environment variables in `.env`.

### Provider Selection

The proxy uses a **Model Registry** to map models to providers. Providers are activated when their API keys are configured. Multiple providers can be active simultaneously.

| Provider | Activation | Prefix Routing |
|----------|-----------|----------------|
| NVIDIA NIM | `NVIDIA_API_KEY` / `NVIDIA_API_KEYS` | `nvidia/*` |
| OpenRouter | `OPENROUTER_API_KEY` / `OPENROUTER_API_KEYS` | `openrouter/*` |
| StepFun | `STEPFUN_API_KEYS` | `stepfun/*` |
| GLM (Zhipu AI) | `GLM_API_KEYS` | `glm-*`, `z-ai/*` |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKENS` | `@cf/*` |
| GoRouter | `GOROUTER_API_KEY` / `GOROUTER_API_KEYS` | `gorouter/*` |
| InferX | `INFERX_API_KEY` / `INFERX_API_KEYS` | `inferx/*` |
| OneHop | `ONEHOP_API_KEY` / `ONEHOP_API_KEYS` | `onehop/*` |
| SeekAI | `SEEKAI_API_KEY_1..5` / `SEEKAI_API_KEYS` | `seekai/*`, `deepseek-*` |
| HCNSec | `HCNSEC_API_KEY_1..5` / `HCNSEC_API_KEYS` | `hcnsec/*` |
| OpenCode Zen | `ZEN_API_KEY_1..5` / `ZEN_API_KEYS` | `zen/*`, `deepseek-v4-flash-free`, `big-pickle` |
| Logfare | `LOGFARE_API_KEY_1..5` / `LOGFARE_API_KEYS` | `logfare/*`, `lfu-*` |
| AgentRouter | `AGENTROUTER_API_KEY` / `AGENTROUTER_API_KEYS` | `agentrouter/*` |
| Databricks | `DATABRICKS_ENDPOINT_1` | `databricks/*`, `databricks-*` |

### Common Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3000` | Server listen port |
| `TIMEOUT` | `120000` | Request timeout in milliseconds |
| `LOG_LEVEL` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `DEBUG` | `false` | Enable debug request/response logging |

### NVIDIA Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NVIDIA_API_KEY` | -- | Single key (lowest priority) |
| `NVIDIA_API_KEY_1..N` | -- | Multiple keys (numbered, up to 100) |
| `NVIDIA_API_KEYS` | -- | Multiple keys (comma-separated, highest priority) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | API base URL |

```env
# Single
NVIDIA_API_KEY=nvapi-your-secret-key-here

# Or numbered
# NVIDIA_API_KEY_1=nvapi-first-key-here
# NVIDIA_API_KEY_2=nvapi-second-key-here

# Or comma-separated
# NVIDIA_API_KEYS=nvapi-key1,nvapi-key2,nvapi-key3
```

### OpenRouter Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | -- | Single key (lowest priority) |
| `OPENROUTER_API_KEY_1..N` | -- | Multiple keys (numbered, up to 100) |
| `OPENROUTER_API_KEYS` | -- | Multiple keys (comma-separated, highest priority) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API base URL |
| `OPENROUTER_SITE_URL` | -- | HTTP-Referer header (optional) |
| `OPENROUTER_SITE_NAME` | -- | X-Title header (optional) |

```env
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

### StepFun Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STEPFUN_API_KEYS` | -- | API keys, comma-separated |
| `STEPFUN_BASE_URL` | `https://api.stepfun.ai/step_plan/v1` | API base URL |

### GLM Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_API_KEYS` | -- | API keys, comma-separated |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | API base URL |

### InferX Configuration

InferX is an OpenAI-compatible provider. Model discovery is fully dynamic — the
proxy fetches the model catalog from `GET /v1/models` at startup (never
hardcoded), so any model your InferX account has access to is automatically
routable.

| Variable | Default | Description |
|----------|---------|-------------|
| `INFERX_API_KEY` | -- | Single key (lowest priority) |
| `INFERX_API_KEY_1..N` | -- | Multiple keys (numbered, up to 100) |
| `INFERX_API_KEYS` | -- | Multiple keys (comma-separated) |
| `INFERX_BASE_URL` | `https://model.inferx.net/endpoints/v1` | API base URL |

Multi-key priority: `INFERX_API_KEY_1..N` (vertical) → `INFERX_API_KEYS` (comma) → `INFERX_API_KEY` (single). Keys are rotated round-robin with automatic failover and per-key cooldown on rate limits.

```env
# Single key
INFERX_API_KEY=sk-inferx-your-key

# Or numbered (recommended for multiple keys)
INFERX_API_KEY_1=sk-inferx-key1
INFERX_API_KEY_2=sk-inferx-key2
INFERX_API_KEY_3=sk-inferx-key3

# Or comma-separated
# INFERX_API_KEYS=sk-inferx-key1,sk-inferx-key2
```

Supported capabilities (forwarded as standard OpenAI Chat Completions):

- Non-streaming `POST /v1/chat/completions`
- Streaming (SSE) `POST /v1/chat/completions` with `stream: true`
- Tool calls / function calling
- Vision (`image_url` content parts), when the selected model supports it
- Dynamic model discovery via `GET /v1/models`

Provider health check: `GET /internal/health/inferx`.

### OneHop Configuration

OneHop is an OpenAI-compatible provider (base URL `https://api.onehop.ai/v1`).
Model discovery is fully dynamic -- the proxy fetches the model catalog from
`GET /v1/models` at startup (never hardcoded), so any model your OneHop account
has access to is automatically routable.

| Variable | Default | Description |
|----------|---------|-------------|
| `ONEHOP_API_KEY` | -- | Single key (lowest priority) |
| `ONEHOP_API_KEY_1..N` | -- | Multiple keys (numbered, up to 100) |
| `ONEHOP_API_KEYS` | -- | Multiple keys (comma-separated) |
| `ONEHOP_BASE_URL` | `https://api.onehop.ai/v1` | API base URL |

Multi-key priority: `ONEHOP_API_KEY_1..N` (vertical) → `ONEHOP_API_KEYS` (comma) → `ONEHOP_API_KEY` (single). Keys are rotated round-robin with automatic failover and per-key cooldown on rate limits.

```env
# Single key
ONEHOP_API_KEY=sk-onehop-your-key

# Or numbered (recommended for multiple keys)
ONEHOP_API_KEY_1=sk-onehop-key1
ONEHOP_API_KEY_2=sk-onehop-key2
ONEHOP_API_KEY_3=sk-onehop-key3

# Or comma-separated
# ONEHOP_API_KEYS=sk-onehop-key1,sk-onehop-key2
```

Supported capabilities (forwarded as standard OpenAI Chat Completions):

- Non-streaming `POST /v1/chat/completions`
- Streaming (SSE) `POST /v1/chat/completions` with `stream: true`
- Tool calls / function calling
- Vision (`image_url` content parts), when the selected model supports it
- Dynamic model discovery via `GET /v1/models`

Provider health check: `GET /internal/health/onehop`.

### SeekAI Configuration

SeekAI is an OpenAI-compatible provider (base URL `https://seekai.cc/v1`).
Model discovery is dynamic when available — the proxy fetches the model catalog
from `GET /v1/models` at startup so any model your SeekAI account has access to
is automatically routable. If the `/v1/models` endpoint is unavailable
(blocked, or not exposed by the upstream), a manual fallback catalog of common
DeepSeek model IDs is used instead so the provider stays routable.

| Variable | Default | Description |
|----------|---------|-------------|
| `SEEKAI_API_KEY_1..5` | -- | Multiple keys (numbered, vertical) — highest priority |
| `SEEKAI_API_KEYS` | -- | Multiple keys (comma-separated) |
| `SEEKAI_API_KEY` | -- | Single key (lowest priority) |
| `SEEKAI_BASE_URL` | `https://seekai.cc/v1` | API base URL |

Multi-key priority: `SEEKAI_API_KEY_1..5` (vertical) → `SEEKAI_API_KEYS` (comma) → `SEEKAI_API_KEY` (single). Keys are rotated round-robin with automatic failover and per-key cooldown on rate limits.

```env
# Numbered (recommended for multiple keys)
SEEKAI_API_KEY_1=sk-seekai-key1
SEEKAI_API_KEY_2=sk-seekai-key2

# Or comma-separated
# SEEKAI_API_KEYS=sk-seekai-key1,sk-seekai-key2

# Or single key
# SEEKAI_API_KEY=sk-seekai-key

SEEKAI_BASE_URL=https://seekai.cc/v1
```

Supported capabilities (forwarded as standard OpenAI Chat Completions):

- Non-streaming `POST /v1/chat/completions`
- Streaming (SSE) `POST /v1/chat/completions` with `stream: true`
- Tool calls / function calling
- Vision (`image_url` content parts), when the selected model supports it
- Dynamic model discovery via `GET /v1/models` (with manual fallback catalog)

Provider health check: `GET /internal/health/seekai`.

### HCNSec Configuration

HCNSec is an OpenAI-compatible provider (base URL `https://api.hcnsec.cn/v1`).
Model discovery is dynamic when available -- the proxy fetches the model catalog
from `GET /v1/models` at startup so any model your HCNSec account has access to
is automatically routable. If the `/v1/models` endpoint is unavailable
(blocked, or not exposed by the upstream), a manual fallback catalog of common
Chinese open-model IDs is used instead so the provider stays routable.

| Variable | Default | Description |
|----------|---------|-------------|
| `HCNSEC_API_KEY_1..5` | -- | Multiple keys (numbered, vertical) — highest priority |
| `HCNSEC_API_KEYS` | -- | Multiple keys (comma-separated) |
| `HCNSEC_API_KEY` | -- | Single key (lowest priority) |
| `HCNSEC_BASE_URL` | `https://api.hcnsec.cn/v1` | API base URL |

Multi-key priority: `HCNSEC_API_KEY_1..5` (vertical) → `HCNSEC_API_KEYS` (comma) → `HCNSEC_API_KEY` (single). Keys are rotated round-robin with automatic failover and per-key cooldown on rate limits.

```env
# Numbered (recommended for multiple keys)
HCNSEC_API_KEY_1=sk-hcnsec-key1
HCNSEC_API_KEY_2=sk-hcnsec-key2

# Or comma-separated
# HCNSEC_API_KEYS=sk-hcnsec-key1,sk-hcnsec-key2

# Or single key
# HCNSEC_API_KEY=sk-hcnsec-key

HCNSEC_BASE_URL=https://api.hcnsec.cn/v1
```

Supported capabilities (forwarded as standard OpenAI Chat Completions):

- Non-streaming `POST /v1/chat/completions`
- Streaming (SSE) `POST /v1/chat/completions` with `stream: true`
- Tool calls / function calling
- Vision (`image_url` content parts), when the selected model supports it
- Dynamic model discovery via `GET /v1/models` (with manual fallback catalog)

Provider health check: `GET /internal/health/hcnsec`.

### AgentRouter Configuration

AgentRouter is an OpenAI-compatible provider (base URL `https://agentrouter.org/v1`).
Model discovery is fully dynamic -- the proxy fetches the model catalog from
`GET /v1/models` at startup (never hardcoded), so any model your AgentRouter
account has access to is automatically routable.

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTROUTER_API_KEY` | -- | Single key (lowest priority) |
| `AGENTROUTER_API_KEY_1..N` | -- | Multiple keys (numbered, up to 100) |
| `AGENTROUTER_API_KEYS` | -- | Multiple keys (comma-separated) |
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org/v1` | API base URL |

Multi-key priority: `AGENTROUTER_API_KEY_1..N` (vertical) → `AGENTROUTER_API_KEYS` (comma) → `AGENTROUTER_API_KEY` (single). Keys are rotated round-robin with automatic failover and per-key cooldown on rate limits.

```env
# Single key
AGENTROUTER_API_KEY=ar-your-key

# Or numbered (recommended for multiple keys)
AGENTROUTER_API_KEY_1=ar-key1
AGENTROUTER_API_KEY_2=ar-key2
AGENTROUTER_API_KEY_3=ar-key3

# Or comma-separated
# AGENTROUTER_API_KEYS=ar-key1,ar-key2
```

Supported capabilities (forwarded as standard OpenAI Chat Completions):

- Non-streaming `POST /v1/chat/completions`
- Streaming (SSE) `POST /v1/chat/completions` with `stream: true`
- Tool calls / function calling
- Vision (`image_url` content parts), when the selected model supports it
- Dynamic model discovery via `GET /v1/models`

Provider health check: `GET /internal/health/agentrouter`.

### Cloudflare Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | -- | Cloudflare account ID (required) |
| `CLOUDFLARE_API_TOKENS` | -- | API tokens, comma-separated |

```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

### Cloudflare Model Mapping

| Request Model | Cloudflare Model ID |
|---------------|-------------------|
| `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` |
| `gpt-oss-120b` | `@cf/openai/gpt-oss-120b` |
| `llama-3.2-3b` | `@cf/meta/llama-3.2-3b-instruct` |
| `llama-3.2-1b` | `@cf/meta/llama-3.2-1b-instruct` |
| `whisper-large-v3` | `@cf/openai/whisper-large-v3` |

Models starting with `@cf/` are forwarded unchanged.

### API Key Priority (All Providers)

All providers follow the same priority:

1. `PROVIDER_API_KEYS` (comma-separated) — highest priority
2. `PROVIDER_API_KEY_1..N` (numbered) — medium priority
3. `PROVIDER_API_KEY` (single) — lowest priority

If `PROVIDER_API_KEYS` is set, all other key variables for that provider are ignored.

**SeekAI** priority: `SEEKAI_API_KEY_1..5` (vertical) → `SEEKAI_API_KEYS` (comma) → `SEEKAI_API_KEY` (single), matching the GoRouter/InferX/OneHop/AgentRouter convention.

**HCNSec** priority: `HCNSEC_API_KEY_1..5` (vertical) → `HCNSEC_API_KEYS` (comma) → `HCNSEC_API_KEY` (single), matching the GoRouter/InferX/OneHop/AgentRouter convention.

---

## Usage

### Development

```bash
npm run dev
```

Starts the server with hot-reload via `tsx watch`. Listens at `http://localhost:3000`.

### Build

```bash
npm run build
```

Compiles TypeScript from `src/` to JavaScript in `dist/`.

### Production

```bash
npm run build
npm start
```

### PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the process
pm2 start dist/server.js --name nvidia-api

# Monitor
pm2 status
pm2 logs nvidia-api
pm2 monit

# Restart / Stop / Delete
pm2 restart nvidia-api
pm2 stop nvidia-api
pm2 delete nvidia-api

# Persist across reboots
pm2 save
pm2 startup
```

### Docker

```bash
# Build the image
docker build -t nvidia-api .

# Run the container
docker run -d \
  --name nvidia-api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  nvidia-api
```

### Docker Compose

```bash
docker compose up -d
```

```yaml
services:
  nvidia-api-proxy:
    build: .
    container_name: nvidia-api-proxy
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Basic health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming + non-streaming) |
| `POST` | `/v1/embeddings` | Generate embeddings |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `GET` | `/internal/keys` | Per-key statistics |
| `GET` | `/internal/health` | System health overview |

---

## OpenAI Compatibility

The proxy exposes OpenAI-compatible endpoints so you can swap it in as a drop-in replacement:

| OpenAI Endpoint | Proxy Endpoint |
|-----------------|----------------|
| `POST /v1/chat/completions` | `POST /v1/chat/completions` |
| `POST /v1/embeddings` | `POST /v1/embeddings` |
| `GET /v1/models` | `GET /v1/models` |
| `POST /v1/responses` | `POST /v1/responses` |

Set your OpenAI client's `baseURL` / `base_url` to `http://localhost:3000/v1` and use any non-empty string as the API key (the proxy manages keys internally).

---

## Health Endpoints

### `GET /health`

Basic health check.

```bash
curl http://127.0.0.1:3000/health
```

```json
{
  "status": "ok",
  "provider": "cloudflare"
}
```

Depending on the provider configuration, the response may show `"provider": "nvidia"`, `"provider": "cloudflare"`, or a multi-provider object.

### `GET /internal/health`

System health overview including key status, request count, and uptime.

```bash
curl http://127.0.0.1:3000/internal/health
```

```json
{
  "provider": "nvidia",
  "totalKeys": 3,
  "activeKeys": 2,
  "cooldownKeys": 1,
  "requests": 1520,
  "uptime": 123456
}
```

With Cloudflare:

```json
{
  "provider": "cloudflare",
  "totalKeys": 0,
  "activeKeys": 0,
  "cooldownKeys": 0,
  "requests": 0,
  "uptime": 123456
}
```

---

## Internal Endpoints

### `GET /internal/keys`

Per-key statistics. API keys are never exposed -- only anonymized metrics.

```bash
curl http://127.0.0.1:3000/internal/keys
```

```json
[
  {
    "id": 1,
    "active": true,
    "cooldown": false,
    "requests": 520,
    "success": 515,
    "failed": 5,
    "retry": 3,
    "averageLatency": 842
  },
  {
    "id": 2,
    "active": false,
    "cooldown": true,
    "requests": 500,
    "success": 498,
    "failed": 2,
    "retry": 1,
    "averageLatency": 798
  }
]
```

---

## Example curl Commands

### Chat Completion (Non-Streaming)

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
   -H "Content-Type: application/json" \
   -H "Authorization: Bearer anything" \
   -d '{
     "model": "meta/llama-3.1-8b-instruct",
     "messages": [{"role": "user", "content": "Hello!"}],
     "temperature": 0.7,
     "max_tokens": 2048,
     "stream": false
   }'
```

### Chat Completion (Streaming)

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
   -H "Content-Type: application/json" \
   -H "Authorization: Bearer anything" \
   -d '{
     "model": "meta/llama-3.1-8b-instruct",
     "messages": [{"role": "user", "content": "Count to 5"}],
     "stream": true
   }'
```

### Embeddings

```bash
curl http://127.0.0.1:3000/v1/embeddings \
   -H "Content-Type: application/json" \
   -H "Authorization: Bearer anything" \
   -d '{
     "model": "nvidia/nv-embedqa-e5-v5",
     "input": "Hello world"
   }'
```

### Models

```bash
curl http://127.0.0.1:3000/v1/models \
   -H "Authorization: Bearer anything"
```

---

## Example OpenAI SDK

### JavaScript / TypeScript

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'anything',
});

// Chat completion
const chat = await client.chat.completions.create({
  model: 'meta/llama-3.1-8b-instruct',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(chat.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
  model: 'meta/llama-3.1-8b-instruct',
  messages: [{ role: 'user', content: 'Count to 5' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// Embeddings
const emb = await client.embeddings.create({
  model: 'nvidia/nv-embedqa-e5-v5',
  input: 'Hello world',
});
console.log(emb.data);
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url='http://localhost:3000/v1',
    api_key='anything',
)

# Chat completion
chat = client.chat.completions.create(
    model='meta/llama-3.1-8b-instruct',
    messages=[{'role': 'user', 'content': 'Hello!'}],
)
print(chat.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model='meta/llama-3.1-8b-instruct',
    messages=[{'role': 'user', 'content': 'Count to 5'}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or '', end='')

# Embeddings
emb = client.embeddings.create(
    model='nvidia/nv-embedqa-e5-v5',
    input='Hello world',
)
print(emb.data)
```

---

## Supported Models

Models are served from the **Model Registry**, which maps each model to one or more providers with priority. Admin can manage mappings at runtime via API (see [Model Registry](#model-registry-admin)).

### Default Models by Provider

| Provider | Example Models |
|----------|---------------|
| **NVIDIA NIM** | `meta/llama-3.1-8b-instruct`, `meta/llama-3.1-70b-instruct`, `mistralai/mistral-7b-instruct-v0.3`, `google/gemma-2-27b-it`, `nvidia/nv-embedqa-e5-v5` |
| **OpenRouter** | All models from `openrouter/models` endpoint |
| **Cloudflare** | `@cf/meta/llama-3.2-3b-instruct`, `@cf/meta/llama-3.2-1b-instruct`, `@cf/openai/gpt-oss-20b`, `@cf/openai/gpt-oss-120b`, `@cf/openai/whisper-large-v3` |
| **GLM (Zhipu AI)** | `glm-5.2`, `glm-5.1`, `glm-4-plus` |
| **StepFun** | `step-2-16k`, `step-1-128k`, `step-1-flash` |
| **GoRouter** | All models from `gorouter/models` endpoint |
| **InferX** | All models from `inferx/models` endpoint (dynamic discovery) |
| **OneHop** | All models from `onehop/models` endpoint (dynamic discovery) |
| **SeekAI** | All models from `seekai/models` endpoint (dynamic discovery; manual fallback catalog when `/v1/models` is unavailable) |
| **HCNSec** | All models from `hcnsec/models` endpoint (dynamic discovery; manual fallback catalog when `/v1/models` is unavailable) |
| **AgentRouter** | All models from `agentrouter/models` endpoint (dynamic discovery) |
| **Databricks** | Custom models from configured endpoints |

### Model List

The proxy serves combined model lists from all active providers at `GET /v1/models`.

### Model Aliases

Model aliases map a client-requested model name to a name registered in the Model Registry. They are used **only for ModelRegistry lookup** — the model name sent to the provider remains the registered name.

**Example**: client sends `deepseek-ai/deepseek-v4-flash` but NVIDIA registers `deepseek-v4-flash`. Without an alias the lookup fails; with an alias the request routes to NVIDIA and upstream still uses `deepseek-v4-flash`.

```env
# Inline JSON
MODEL_ALIASES={"deepseek-ai/deepseek-v4-flash":"deepseek-v4-flash"}

# Or JSON file
MODEL_ALIASES_PATH=/path/to/model-aliases.json
```

Admin API for runtime management:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/aliases` | List all aliases |
| `POST` | `/admin/aliases` | Add an alias |
| `DELETE` | `/admin/aliases/:encodedAlias` | Remove an alias |

Aliases take effect immediately without restart. Every resolution logs `Requested Model` / `Resolved Alias` / `Registry Model` / `Matched Provider`.

### Provider Backend Model Mapping

Each provider can use a different **backend model name** while the client keeps sending the same model. The Model Registry stays keyed on the client/virtual model; the `backendModel` is only substituted before the upstream request.

**Example**: client always sends `meta/llama-3.1-8b-instruct`:
- NVIDIA backend: `meta/llama-3.1-8b-instruct` (no mapping needed)
- Cloudflare backend: `@cf/meta/llama-3.2-3b-instruct`

```json
// POST /admin/models
{ "model": "meta/llama-3.1-8b-instruct", "providerId": "cloudflare", "backendModel": "@cf/meta/llama-3.2-3b-instruct" }
```

Admin API for runtime management:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/models` | List all registered models per provider (includes `backendModel`) |
| `POST` | `/admin/models` | Register a model `{ "model", "providerId", "priority?", "enabled?", "backendModel?" }` |
| `PATCH` | `/admin/models/:providerId/:encodedModel` | Update `priority` / `enabled` / `backendModel` |
| `DELETE` | `/admin/models/:providerId/:encodedModel` | Remove a mapping |

Rules:
- The client request model is **never modified**.
- If `backendModel` is empty/not set, the provider receives the client model as-is.
- Routing logs show `Requested Model` / `Selected Provider` / `Backend Model` before every upstream call.

---

## Multi API Key

Configure multiple API keys per provider to distribute load and increase aggregate rate limits.

All providers share the same key infrastructure (round-robin, cooldown, retry, failover).

### All Providers

All key-based providers follow the same pattern:

| Method | Variable | Description | Priority |
|--------|----------|-------------|----------|
| Comma-separated | `PROVIDER_API_KEYS` | Best for many keys, single env var | Highest |
| Numbered | `PROVIDER_API_KEY_1`, `PROVIDER_API_KEY_2`, ... | Best for clarity | Medium |
| Single | `PROVIDER_API_KEY` | Simplest setup | Lowest |

### NVIDIA

```env
NVIDIA_API_KEY=nvapi-your-secret-key-here
# or
NVIDIA_API_KEY_1=nvapi-first-key
NVIDIA_API_KEY_2=nvapi-second-key
# or
NVIDIA_API_KEYS=nvapi-key1,nvapi-key2,nvapi-key3
```

### OpenRouter

```env
OPENROUTER_API_KEY=sk-or-v1-your-key
# or
OPENROUTER_API_KEY_1=sk-or-v1-key1
OPENROUTER_API_KEY_2=sk-or-v1-key2
# or
OPENROUTER_API_KEYS=sk-or-v1-key1,sk-or-v1-key2
```

### Cloudflare

Cloudflare uses API tokens instead of keys, but follows the same pattern:

```env
CLOUDFLARE_API_TOKENS=token1,token2,token3
```

### GLM

```env
GLM_API_KEYS=key1,key2,key3
# or
GLM_API_KEY_1=key1
GLM_API_KEY_2=key2
# or
GLM_API_KEYS=key1,key2,key3
```

### StepFun

```env
STEPFUN_API_KEYS=key1,key2,key3
# or
STEPFUN_API_KEY_1=key1
STEPFUN_API_KEY_2=key2
# or
STEPFUN_API_KEYS=key1,key2,key3
```

### Databricks

Databricks uses endpoint configurations (base URL + API key) and follows the same pattern for multiple endpoints:

```env
DATABRICKS_ENDPOINT_1=https://instance1.cloud.databricks.com/serving-endpoints|token1
DATABRICKS_ENDPOINT_2=https://instance2.cloud.databricks.com/serving-endpoints|token2
# or
DATABRICKS_ENDPOINT_1=https://instance1.cloud.databricks.com/serving-endpoints|token1
DATABRICKS_ENDPOINT_2=https://instance2.cloud.databricks.com/serving-endpoints|token2
```

### InferX

InferX uses numbered keys first (vertical), then comma-separated, then single key:

```env
INFERX_API_KEY_1=sk-inferx-key1
INFERX_API_KEY_2=sk-inferx-key2
# or
INFERX_API_KEYS=sk-inferx-key1,sk-inferx-key2
# or
INFERX_API_KEY=sk-inferx-single-key
```

### OneHop

OneHop uses numbered keys first (vertical), then comma-separated, then single key:

```env
ONEHOP_API_KEY_1=sk-onehop-key1
ONEHOP_API_KEY_2=sk-onehop-key2
# or
ONEHOP_API_KEYS=sk-onehop-key1,sk-onehop-key2
# or
ONEHOP_API_KEY=sk-onehop-single-key
```

### SeekAI

SeekAI uses numbered keys first (vertical), then comma-separated, then single key:

```env
SEEKAI_API_KEY_1=sk-seekai-key1
SEEKAI_API_KEY_2=sk-seekai-key2
# SEEKAI_API_KEYS=sk-seekai-key1,sk-seekai-key2
# SEEKAI_API_KEY=sk-seekai-key
SEEKAI_BASE_URL=https://seekai.cc/v1
```

### HCNSec

HCNSec uses numbered keys first (vertical), then comma-separated, then single key:

```env
HCNSEC_API_KEY_1=sk-hcnsec-key1
HCNSEC_API_KEY_2=sk-hcnsec-key2
# HCNSEC_API_KEYS=sk-hcnsec-key1,sk-hcnsec-key2
# HCNSEC_API_KEY=sk-hcnsec-key
HCNSEC_BASE_URL=https://api.hcnsec.cn/v1
```

### AgentRouter

AgentRouter uses numbered keys first (vertical), then comma-separated, then single key:

```env
AGENTROUTER_API_KEY_1=ar-key1
AGENTROUTER_API_KEY_2=ar-key2
# or
AGENTROUTER_API_KEYS=ar-key1,ar-key2
# or
AGENTROUTER_API_KEY=ar-single-key
```

---

## Retry

When a request fails with a retryable error, the proxy transparently fails over to the next available key.

### Retryable Status Codes

| Status | Condition | Action |
|--------|-----------|--------|
| `401` | Unauthorized | Retry with next key |
| `403` | Forbidden | Retry with next key |
| `429` | Rate Limited | Cooldown key + retry with next key |
| `500` | Internal Server Error | Retry with next key |
| `502` | Bad Gateway | Retry with next key |
| `503` | Service Unavailable | Retry with next key |
| `504` | Gateway Timeout | Retry with next key |

### Retryable Error Messages

The proxy also retries on network-level errors:
- Timeout
- Network error
- ECONNREFUSED
- ECONNRESET
- ENOTFOUND
- Rate limit / quota exceeded

All available keys are tried once. If all keys fail, the last error is returned in OpenAI format.

---

## Round Robin

Requests are distributed sequentially across all active API keys:

```
Request #1  ->  Key #1
Request #2  ->  Key #2
Request #3  ->  Key #3
Request #4  ->  Key #1  (wraps around)
```

- O(1) key selection with thread-safe Promise-based lock
- Keys in cooldown are automatically skipped
- The round-robin index is shared across all request types (chat, embeddings, models)

---

## Cooldown

When a key receives a `429` (Rate Limited / Quota Exceeded):

1. The key is immediately marked for cooldown
2. It is excluded from round-robin rotation for **60 seconds**
3. After 60 seconds, the key is automatically reactivated on the next request
4. If **all** keys are in cooldown, the proxy returns `HTTP 429` with an OpenAI-compatible error
5. A background task runs every **5 minutes** to clean up expired cooldowns

---

## Error Handling

All errors follow the OpenAI error format:

```json
{
  "error": {
    "message": "NVIDIA API error (401): Invalid API key",
    "type": "authentication_error",
    "code": "401"
  }
}
```

### Error Codes

| Code | Type | Description |
|------|------|-------------|
| `400` | `invalid_request_error` | Missing or invalid request parameters |
| `401` | `authentication_error` | Invalid NVIDIA API key |
| `403` | `permission_error` | Forbidden |
| `404` | `not_found` | Model or endpoint not found |
| `429` | `rate_limit_error` | All keys in cooldown or NVIDIA rate limit |
| `500` | `internal_server_error` | Unexpected server error |
| `502` | `bad_gateway` | Bad upstream response |
| `503` | `service_unavailable` | NVIDIA NIM API unreachable |
| `504` | `gateway_timeout` | Gateway timeout |

---

## Logging

### Log Levels

| Level | Description |
|-------|-------------|
| `trace` | Most verbose, includes all internal operations |
| `debug` | Detailed debugging information |
| `info` | Normal operational messages (default) |
| `warn` | Warning conditions (retries, cooldowns) |
| `error` | Error conditions (request failures) |
| `fatal` | Critical errors (server crashes) |

### Debug Mode

Set `DEBUG=true` in `.env` to enable detailed request/response logging. API keys are masked in all logs (only first and last 4 characters shown, e.g. `nvap****xxxx`).

---

## Development

```bash
# Clone and install
git clone https://github.com/your-username/nvidia-api.git
cd nvidia-api
npm install

# Start with hot-reload
npm run dev

# Run tests
npm test

# Watch tests
npm run test:watch

# Lint (type-check)
npm run lint
```

### Project Structure

```
nvidia-api/
├── config/
│   ├── models.json           # Fallback model list
│   └── models.example.json   # Example model list
├── src/
│   ├── server.ts             # Fastify entry point
│   ├── config.ts             # Environment configuration
│   ├── lib/
│   │   ├── model-registry.ts # Model↔Provider routing registry
│   │   ├── key-manager.ts    # Round robin, cooldown, health
│   │   ├── types.ts          # Shared types and interfaces
│   │   ├── openaiResponse.ts # OpenAI-compatible response formatters
│   │   └── utils.ts          # Shared utilities
│   ├── providers/
│   │   ├── registry.ts       # Provider registry (multi-provider)
│   │   ├── nvidia/           # NVIDIA NIM provider
│   │   ├── openrouter/       # OpenRouter provider
│   │   ├── stepfun/          # StepFun provider
│   │   ├── glm/              # GLM (Zhipu AI) provider
│   │   ├── cloudflare/       # Cloudflare Workers AI provider
│   │   ├── gorouter/         # GoRouter provider
│   │   ├── inferx/           # InferX provider
│   │   ├── onehop/           # OneHop provider
│   │   ├── seekai/           # SeekAI provider
│   │   ├── hcnsec/           # HCNSec provider
│   │   ├── agentrouter/      # AgentRouter provider
│   │   └── databricks/       # Databricks provider
│   ├── routes/
│   │   ├── chat.ts           # POST /v1/chat/completions
│   │   ├── embeddings.ts     # POST /v1/embeddings
│   │   ├── models.ts         # GET /v1/models
│   │   ├── responses.ts      # POST /v1/responses
│   │   ├── admin.ts          # Admin UI + APIs
│   │   └── internal.ts       # GET /internal/*
│   ├── services/
│   │   └── provider.ts       # Unified provider resolver
│   └── utils/
│       └── responses.ts      # Responses API transform
├── tests/                    # Test suite (117+ tests)
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # Docker Compose configuration
└── package.json
```

---

## Production Deployment

### Build & Start

```bash
npm run build
NODE_ENV=production npm start
```

### Ubuntu VPS with PM2

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone https://github.com/your-username/nvidia-api.git /opt/nvidia-api
cd /opt/nvidia-api
cp .env.example .env
# Edit .env with your API keys
npm install
npm run build

# PM2
npm install -g pm2
pm2 start dist/server.js --name nvidia-api
pm2 save
pm2 startup

# Firewall
sudo ufw allow 3000
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
```

---

## Security

- **API keys are never exposed** to clients. The proxy uses keys internally for upstream authentication
- Client-provided `Authorization` headers are accepted but **never forwarded** to NVIDIA
- Request logging masks API keys, showing only the first and last 4 characters (`nvap****xxxx`)
- Internal API endpoints (`/internal/*`) return key statistics but **never** the actual key values
- The proxy operates as pure middleware -- **no data is persisted** to disk or database
- Non-root user in Docker container (security best practice)

---

## Performance

| Aspect | Detail |
|--------|--------|
| **Round Robin** | O(1) key selection with Promise-based lock for concurrent safety |
| **Retry** | Failover to next key in <1ms -- no backoff delay between key switches |
| **Failover** | Transparent to the client; only the final error is returned if all keys fail |
| **Streaming** | Piped directly from NVIDIA NIM via Axios streams -- no buffering |
| **Connection Reuse** | Axios connection pooling with keep-alive |
| **Stateless** | No database, no disk I/O for request processing |
| **Fastify** | One of the fastest Node.js HTTP frameworks |

---

## Troubleshooting

### Common Issues

**"No API keys configured"**
Ensure at least one provider's key variable is set in `.env` (e.g. `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `STEPFUN_API_KEYS`, `GLM_API_KEYS`, `CLOUDFLARE_API_TOKENS`, or `DATABRICKS_ENDPOINT_1`).

**"All API keys are currently in cooldown"**
All configured keys received `429` rate limits. Wait 60 seconds for keys to recover, or add more keys.

**Connection refused**
Ensure the server is running and the port is correct. Check firewall rules (default: `3000`).

**Streaming not working in nginx**
Set `proxy_buffering off;` and `proxy_cache off;` in your nginx configuration for SSE to work.

**Slow responses**
Check the `TIMEOUT` setting (default 30s). Network latency to NVIDIA NIM API may vary by region.

---

## FAQ

**Q: Do I need an NVIDIA API key?**
A: Not necessarily. You can use any supported provider (NVIDIA, OpenRouter, StepFun, GLM, Cloudflare, GoRouter, InferX, OneHop, SeekAI, HCNSec, AgentRouter, or Databricks). Configure at least one provider's API keys.

**Q: What API key should I use in my OpenAI client?**
A: Any non-empty string. The proxy ignores the client's API key and uses its own configured keys.

**Q: Can I use this with any OpenAI SDK?**
A: Yes. Any SDK or tool that supports OpenAI-compatible endpoints works -- just change the `baseURL`.

**Q: How many API keys can I configure?**
A: There is no built-in limit. The proxy scans `PROVIDER_API_KEY_1` through `PROVIDER_API_KEY_100` for each provider.

**Q: Does the proxy persist any data?**
A: No. The proxy is completely stateless -- no database, no filesystem writes during operation.

**Q: What happens when all keys are rate-limited?**
A: The proxy returns `HTTP 429` with an OpenAI-compatible error. Keys auto-recover after 60 seconds.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features including multi-provider support, Prometheus metrics, admin dashboard, and more.

---

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.