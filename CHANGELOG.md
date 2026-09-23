# Changelog

## [Unreleased]

### Added
- Admin "Download Backup" button: on-demand full-project ZIP download via `GET /admin/backup/download` (admin-authenticated, timestamped `nvidia-api-backup-YYYY-MM-DD-HH-mm-ss.zip`, streamed, no server-side file). Bundles allowlisted state/config (`usage-records.json` sanitized, `provider-state.json`, `combos.json`, `model-pricing.json`, `provider-refresh-cooldown-state.json`, `models.json`, `package.json`, `.env.example`, `CHANGELOG.md`) plus `manifest.json`; raw credentials (`provider-api-keys.json`, `client-api-keys.json`), `.env*`, `codex-seekai.toml`, previous backups and repo clutter are excluded by design
- ExperientialLabs OpenAI-compatible provider (base URL `https://api.experientiallabs.ai/v1`)
  - Chat completions (streaming + non-streaming) via `POST /v1/chat/completions`
  - Dynamic model discovery via `GET /v1/models` (±696 ids) with manual fallback catalog
  - Env config: `EXPERIENTIALLABS_API_KEY_1..N` (numbered), `EXPERIENTIALLABS_API_KEYS` (comma), `EXPERIENTIALLABS_API_KEY` (single), `EXPERIENTIALLABS_BASE_URL` and `EXPERIENTIALLABS_TIMEOUT`
  - Health check at `GET /internal/health/experientiallabs`
- SeekAI OpenAI-compatible provider (base URL `https://seekai.cc/v1`)
  - Chat completions (streaming + non-streaming) via `POST /v1/chat/completions`
  - Dynamic model discovery via `GET /v1/models` with manual fallback catalog
  - Env config: `SEEKAI_API_KEY` (single key, no other key fallback) and `SEEKAI_BASE_URL`
  - Health check at `GET /internal/health/seekai`
- HCNSec OpenAI-compatible provider (base URL `https://api.hcnsec.cn/v1`)
  - Chat completions (streaming + non-streaming) via `POST /v1/chat/completions`
  - Dynamic model discovery via `GET /v1/models` with manual fallback catalog
  - Env config: `HCNSEC_API_KEY_1..5` (numbered), `HCNSEC_API_KEYS` (comma), `HCNSEC_API_KEY` (single) and `HCNSEC_BASE_URL`
  - Health check at `GET /internal/health/hcnsec`

## [1.0.0] - 2025-01-01

### Added
- Initial release of api-proxy
- OpenAI-compatible `/v1/chat/completions` endpoint (streaming and non-streaming)
- OpenAI-compatible `/v1/embeddings` endpoint
- OpenAI-compatible `/v1/models` endpoint with config fallback
- OpenAI Responses API `/v1/responses` endpoint
- Health check at `GET /health`
- Internal monitoring at `/internal/keys` and `/internal/health`
- Round-robin API key distribution with automatic failover
- Rate-limit cooldown (60s) per key on 429 responses
- Retry logic for transient errors (401, 403, 429, 5xx, timeouts, network errors)
- Per-key statistics tracking (requests, success, failures, latency)
- Background health checker (5-minute interval)
- Multi-stage Docker build
- Comprehensive test suite (56 tests)
- TypeScript with strict mode
- Configurable via environment variables
