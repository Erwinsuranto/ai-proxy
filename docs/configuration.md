# Configuration

## Provider Selection

The proxy uses the **Model Registry** to map models to providers. Each provider is activated when its API keys are configured:

| Provider | Activation Condition | Prefix Routing |
|----------|---------------------|----------------|
| NVIDIA NIM | `NVIDIA_API_KEY` / `NVIDIA_API_KEYS` | `nvidia/*` |
| OpenRouter | `OPENROUTER_API_KEY` / `OPENROUTER_API_KEYS` | `openrouter/*` |
| StepFun | `STEPFUN_API_KEYS` | `stepfun/*` |
| GLM (Zhipu AI) | `GLM_API_KEYS` | `glm-*`, `z-ai/*` |
| Cloudflare | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKENS` | `@cf/*` |
| Databricks` | `@cf/*` |
| Databricks | `DATABRICKS_ENDPOINT_1` | `databricks/*`, `databricks-*` |

Multiple providers can be active simultaneously. Routing is determined by the Model Registry (model → provider mapping).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3000` | Server listen port |
| `TIMEOUT` | `120000` | Request timeout in milliseconds |
| `LOG_LEVEL` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `DEBUG` | `false` | Enable debug request/response logging |
| `NODE_ENV` | — | Set to `production` for production mode |

### NVIDIA NIM

| Variable | Default | Description |
|----------|---------|-------------|
| `NVIDIA_API_KEY` | — | Single API key (lowest priority) |
| `NVIDIA_API_KEY_1..N` | — | Multiple keys (numbered variables, up to 100) |
| `NVIDIA_API_KEYS` | — | Multiple keys (comma-separated, highest priority) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | API base URL |

### OpenRouter

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | Single API key (lowest priority) |
| `OPENROUTER_API_KEY_1..N` | — | Multiple keys (numbered variables, up to 100) |
| `OPENROUTER_API_KEYS` | — | Multiple keys (comma-separated, highest priority) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API base URL |
| `OPENROUTER_SITE_URL` | — | HTTP-Referer header (optional) |
| `OPENROUTER_SITE_NAME` | — | X-Title header (optional) |

### StepFun

| Variable | Default | Description |
|----------|---------|-------------|
| `STEPFUN_API_KEYS` | — | API keys, comma-separated |
| `STEPFUN_BASE_URL` | `https://api.stepfun.ai/step_plan/v1` | API base URL |

### GLM (Zhipu AI)

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_API_KEYS` | — | API keys, comma-separated |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | API base URL |

### Cloudflare

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare account ID (required) |
| `CLOUDFLARE_API_TOKENS` | — | API tokens, comma-separated |

### Databricks

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABRICKS_ENDPOINT_1..N` | — | Endpoint configs: `baseURL|apiKey` |
| `DATABRICKS_MODEL_MAP_PATH` | — | JSON file for model alias mapping |
| `DATABRICKS_ALIAS_PATH` | — | JSON file for virtual alias mapping |

## API Key Priority

All providers that support multiple key methods follow the same priority:

1. `PROVIDER_API_KEYS` (comma-separated) — highest priority
2. `PROVIDER_API_KEY_1` through `PROVIDER_API_KEY_100` — numbered variables
3. `PROVIDER_API_KEY` — single key fallback — lowest priority

If `PROVIDER_API_KEYS` is set, all other key variables for that provider are ignored.

## .env File

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### NVIDIA

```env
NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

Multiple keys:
```env
NVIDIA_API_KEYS=nvapi-key1,nvapi-key2,nvapi-key3
```
or:
```env
NVIDIA_API_KEY_1=nvapi-key1
NVIDIA_API_KEY_2=nvapi-key2
NVIDIA_API_KEY_3=nvapi-key3
```

### Cloudflare

```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

### OpenRouter

```env
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

### StepFun

```env
STEPFUN_API_KEYS=your-stepfun-key
STEPFUN_BASE_URL=https://api.stepfun.ai/step_plan/v1
```

### GLM

```env
GLM_API_KEYS=your-glm-key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
```

### Databricks

```env
DATABRICKS_ENDPOINT_1=https://dbc-xxx.cloud.databricks.com/serving-endpoints|dapi-your-key
```

## Cloudflare Model Mapping

| Request Model | Cloudflare Model ID |
|---------------|-------------------|
| `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` |
| `gpt-oss-120b` | `@cf/openai/gpt-oss-120b` |
| `llama-3.2-3b` | `@cf/meta/llama-3.2-3b-instruct` |
| `llama-3.2-1b` | `@cf/meta/llama-3.2-1b-instruct` |
| `whisper-large-v3` | `@cf/openai/whisper-large-v3` |

Models starting with `@cf/` are forwarded unchanged.

## Model Registry

The Model Registry maps each model to one or more providers with a priority. Admin can manage mappings at runtime via API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/models` | List all model-provider mappings |
| `POST` | `/admin/models` | Register a model to a provider |
| `PATCH` | `/admin/models/:providerId/:encodedModel` | Update priority/enabled |
| `DELETE` | `/admin/models/:providerId/:encodedModel` | Remove a model from a provider |

Changes take effect immediately without server restart.

## Provider Management

Every configured provider can be listed and toggled at runtime (enable/disable) without restarting the server.

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/providers` | List all registered providers with `id`, `name`, `enabled`, `models` |
| `PATCH` | `/admin/providers/:providerId` | Enable/disable a provider `{ "enabled": true|false }` |

```bash
# List all providers
curl http://localhost:3000/admin/providers

# Disable a provider
curl -X PATCH http://localhost:3000/admin/providers/nvidia \
  -H 'Content-Type: application/json' -d '{"enabled": false}'

# Re-enable a provider
curl -X PATCH http://localhost:3000/admin/providers/nvidia \
  -H 'Content-Type: application/json' -d '{"enabled": true}'
```

### Behavior

- **Disabled providers** are excluded from routing for new requests immediately — the provider cannot be selected for any model, and virtual routes pointing to it are skipped. Existing configuration (API keys, models, endpoints) is **never deleted**.
- **Re-enabling** restores the provider to full service without reconfiguration.
- **Persistence**: the runtime enable/disable state is stored in `config/provider-state.json` and reloaded at startup, so it survives server restarts.
- **Validation**: `PATCH /admin/providers/:providerId` returns `404` when the provider is not configured, and `400` when the `enabled` field is missing.

### Adding a provider (via code, not UI)

The admin UI **only** lists providers, lists models, and enable/disable a provider. There is deliberately **no "Add Provider" / "Edit Provider" / "Delete Provider"** endpoint or UI — providers are added through code:

1. Create a provider implementation under `src/providers/<id>/` that exports `getProviderInfo()` and the chat/raw/stream/embeddings methods.
2. Register the provider in `src/providers/registry.ts` at startup (provider + credential loader).
3. Set the corresponding credential environment variables (e.g. `NVIDIA_API_KEY`, `TOKENHARBOR_API_KEY_1..5`).

This keeps the multi-provider architecture static and auditable. The Usage, Backup/Restore, and Enable/Disable features are the operational surface; the provider set itself is controlled by code review.

### Startup Configuration

Provider status can also be seeded from environment variables at startup:

| Variable | Description |
|----------|-------------|
| `DISABLE_PROVIDERS` | Comma-separated provider IDs to disable |
| `ENABLED_PROVIDERS` | Comma-separated provider IDs to keep enabled (all other known providers are disabled) |

```env
DISABLE_PROVIDERS=stepfun,glm
# or
ENABLED_PROVIDERS=nvidia,openrouter
```

Runtime toggles via the Admin API are merged with these env seeds on startup; env seeds always apply, and persisted runtime state is additive.

## Model Aliases

Model aliases map a client-requested model name to a model name registered in the Model Registry. They are used **only for ModelRegistry lookup** — the model name sent to the provider remains the registered name.

**Use case**: client sends `deepseek-ai/deepseek-v4-flash` but NVIDIA registers `deepseek-v4-flash`. Without an alias the lookup fails with "model not found". With an alias, lookup succeeds and the upstream request still uses `deepseek-v4-flash`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL_ALIASES_PATH` | — | Path to JSON file mapping alias → target |
| `MODEL_ALIASES` | — | Inline JSON mapping alias → target |

```env
MODEL_ALIASES_PATH=/path/to/model-aliases.json
```

```json
{
  "deepseek-ai/deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro": "deepseek-v4-pro"
}
```

or inline:

```env
MODEL_ALIASES={"deepseek-ai/deepseek-v4-flash":"deepseek-v4-flash"}
```

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/aliases` | List all aliases |
| `POST` | `/admin/aliases` | Add an alias `{ "alias": "...", "target": "..." }` |
| `DELETE` | `/admin/aliases/:encodedAlias` | Remove an alias |

Aliases take effect immediately without server restart.

## Provider Backend Model Mapping

Each provider can use a different backend model name while the client keeps sending the same model. The Model Registry stays keyed on the client/virtual model; `backendModel` is substituted only before the upstream request.

**Example**: client sends `meta/llama-3.1-8b-instruct`; NVIDIA uses the same name, Cloudflare uses `@cf/meta/llama-3.2-3b-instruct`.

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

## Routing Logs

Every model resolution logs:

```
Requested Model:     meta/llama-3.1-8b-instruct
Resolved Alias:      meta/llama-3.1-8b-instruct
Registry Model:      meta/llama-3.1-8b-instruct
Matched Provider:    nvidia (meta/llama-3.1-8b-instruct)
```

Before each upstream call, backend selection is logged:

```
Requested Model:     meta/llama-3.1-8b-instruct
Selected Provider:   nvidia
Backend Model:       meta/llama-3.1-8b-instruct
```

## Usage Tracking

Every API request is recorded with timestamp, provider, model, status (success/error/blocked), latency, and token usage (when available from the upstream response). Usage data is persisted in `config/usage-records.json` and can be queried via admin endpoints.

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/usage` | Aggregate usage stats (optional filters: `?provider=&model=&status=&from=&to=`) |
| `GET` | `/admin/usage/providers` | Usage breakdown per provider (optional: `?from=&to=`) |
| `GET` | `/admin/usage/models` | Usage breakdown per model (optional: `?from=&to=`) |
| `GET` | `/admin/usage/records` | Raw usage records (paginated: `?limit=100&offset=0`; filter: `?provider=&model=&status=&from=&to=&search=`) |
| `GET` | `/admin/usage/records/:index` | Single usage record detail |
| `GET` | `/admin/logs` | Request logs (alias for `/admin/usage/records` with filters: `?provider=&model=&status=&from=&to=&search=&limit=&offset=`) |

```bash
# Get aggregate stats
curl http://localhost:3000/admin/usage

# Get per-provider breakdown
curl http://localhost:3000/admin/usage/providers

# Get per-model breakdown
curl http://localhost:3000/admin/usage/models

# Get raw records (last 50)
curl "http://localhost:3000/admin/usage/records?limit=50"

# Filter by provider, model, status, time range
curl "http://localhost:3000/admin/usage?provider=nvidia&status=success&from=1700000000000&to=1800000000000"

# Get a single record detail by index
curl http://localhost:3000/admin/usage/records/0

# Search logs by request ID, error message, or provider
curl "http://localhost:3000/admin/logs?search=403&limit=10"

# Filter logs by status
curl "http://localhost:3000/admin/logs?status=error&limit=20"
```

### Behavior

- **Tracking is non-blocking**: if recording fails (disk full, etc.), the error is silently caught and the original request is never affected.
- **Token usage** is extracted from the upstream response (`usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`). If the provider does not return token usage, these fields are `null`.
- **Blocked requests**: when a provider is disabled or a model is not found, the request is recorded as `blocked` with provider `unknown`.
- **Error requests**: when a provider is selected but the upstream call fails, the request is recorded as `error` with the provider that was attempted, including `httpStatus` and `errorMessage`.
- **Persistence**: records are flushed to disk every 5 seconds via a background timer. They are also flushed on `SIGTERM`/`SIGINT`/`exit`.
- **Credential safety**: `apiKey` field stores a client identifier (not a credential). If a masked provider key is recorded, it is stored in `apiKeyMasked` (first 4 chars + `***` + last 4 chars). Raw API keys are never stored.
- **Dashboard fields**: provider and model breakdowns include `avgLatencyMs`, `promptTokens`, `completionTokens`, `totalTokens`, and per-status counts (`success`, `failed`, `blocked`).

## Backup & Restore

Backups persist the operational state needed to recover after data loss: usage records and provider enable/disable state. They are stored as JSON files in `config/backups/`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/backup` | Create a backup (returns `backupId`, `createdAt`, `checksum`, `metadata`) |
| `GET` | `/admin/backup/list` | List all backups with `backupId`, `createdAt`, `usageRecordCount`, `providerStateCount`, `size`, `version`, `valid` |
| `GET` | `/admin/backup/info/:backupId` | Detail for one backup |
| `GET` | `/admin/backup/download/:backupId` | Download the raw backup JSON |
| `GET` | `/admin/backup/download` | Download a fresh full-project ZIP (`nvidia-api-backup-YYYY-MM-DD-HH-mm-ss.zip`, streamed, admin only) |
| `POST` | `/admin/backup/restore/:backupId` | Restore (auto-creates a pre-restore snapshot first) |
| `DELETE` | `/admin/backup/:backupId` | Delete a backup |

### Behavior

- **Datasets**: a backup contains `usage` records and `providerState` (the `disabledProviders` list). It also carries `backupVersion`, `backupId`, `createdAt`, `checksum`, and `sourceVersion`.
- **Validation on restore**: the version, structure, and checksum are checked before any data is written. An invalid backup returns an error and writes nothing.
- **Pre-restore snapshot**: before overwriting current data, a new backup is automatically created so the pre-restore state is recoverable. The snapshot backup id is returned as `preRestoreBackupId`.
- **No automatic restore on startup**: restore only happens when the admin explicitly calls `POST /admin/backup/restore/:backupId`.
- **Retention**: if `BACKUP_MAX_BACKUPS` is set to `N > 0`, the oldest backups are pruned after a new backup is created. Otherwise all backups are kept.

### Security (Prompt 13/14 safety guarantees)

A backup **never** contains:

- raw NVIDIA / TokenHarbor / provider API keys
- `Authorization` / `Bearer` headers
- `.env` contents, private keys, passwords, or any provider credential

The usage records' `apiKey` field (a non-credential client identifier) is stripped to `null` before it enters a backup via `sanitizeUsageRecords()`. Only the already-masked `apiKeyMasked` value is preserved. No encryption is fabricated; the safety model is **non-inclusion** of secrets.

### Full-project ZIP download

The **Download Backup** button in the Admin dashboard (Backup & Restore tab) calls `GET /admin/backup/download`, which builds a fresh ZIP on demand and streams it as an `attachment` (`nvidia-api-backup-YYYY-MM-DD-HH-mm-ss.zip`). No ZIP file is stored on the server and no temporary file is left behind.

- **Included (allowlist only)**: sanitized `usage-records.json`, `provider-state.json`, `combos.json`, `model-pricing.json`, `provider-refresh-cooldown-state.json`, `models.json` / `models.example.json`, `package.json`, `.env.example`, `CHANGELOG.md`, plus a generated `manifest.json` (file list with SHA-256 checksums).
- **Excluded by design**: `provider-api-keys.json` and `client-api-keys.json` (raw credentials / key hashes — re-add or re-mint after a restore), `.env` / `.env.*`, `codex-seekai.toml` (contains a hardcoded token), previous snapshots in `backups/`, `*.zip`, `node_modules`, `.git`, `dist`, logs, cache and temp files.
- **Auth**: same admin `Bearer` / `x-api-key` hook as every `/admin/**` route — the endpoint is never public. Failures return a generic JSON error without secrets or filesystem paths.

## Verification Providers

The two providers used for end-to-end verification are **NVIDIA** and **TokenHarbor.ai**. Both are real registered providers and should be live-tested only when their credentials are present and have inference permission (a `401`/`403` upstream response is reported verbatim — never bypassed or faked). **Gorouter.app is not used** in production verification: it is excluded from the live test suite (`tests/gorouter.test.ts` and the gorouter `/v1/models` assertion are marked `skip`), never used as a fallback, and no Gorouter credential is provisioned.