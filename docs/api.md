# API Reference

## Base URL

All endpoints are served at `http://localhost:3000` by default.

## Endpoints

### Health Check

```
GET /health
```

Returns service health status.

**Response:**
```json
{
  "status": "ok",
  "provider": "nvidia"
}
```

### List Models

```
GET /v1/models
```

Returns available models from the NVIDIA API. Falls back to `config/models.json` if the NVIDIA API is unreachable.

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "nvidia/llama-3.1-8b-instruct",
      "object": "model",
      "created": 1730000000,
      "owned_by": "nvidia"
    }
  ]
}
```

### Chat Completions

```
POST /v1/chat/completions
```

OpenAI-compatible chat completions endpoint. Supports both streaming and non-streaming modes.

**Request Body:**
```json
{
  "model": "nvidia/llama-3.1-8b-instruct",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

**Non-streaming Response:** Standard OpenAI chat completion format.

**Streaming Response:** Server-Sent Events with `data:` prefixes and `data: [DONE]` termination.

### Embeddings

```
POST /v1/embeddings
```

OpenAI-compatible embeddings endpoint.

**Request Body:**
```json
{
  "model": "nvidia/nv-embed-qa-4",
  "input": "The quick brown fox jumps over the lazy dog",
  "encoding_format": "float"
}
```

### Responses API

```
POST /v1/responses
```

OpenAI Responses API endpoint. Converts between Responses API format and chat completions format.

**Request Body:**
```json
{
  "model": "nvidia/llama-3.1-8b-instruct",
  "input": "Hello!",
  "instructions": "You are a helpful assistant.",
  "stream": false
}
```

### Internal: Key Stats

```
GET /internal/keys
```

Returns per-key statistics without exposing the actual keys.

**Response:**
```json
[
  {
    "id": 1,
    "active": true,
    "cooldown": false,
    "requests": 42,
    "success": 40,
    "failed": 2,
    "retry": 1,
    "averageLatency": 850
  }
]
```

### Internal: Health

```
GET /internal/health
```

Returns system health overview.

**Response:**
```json
{
  "provider": "nvidia",
  "totalKeys": 3,
  "activeKeys": 2,
  "cooldownKeys": 1,
  "requests": 150,
  "uptime": 3600000
}
```

## Common Error Codes

| Status | Type | Description |
|--------|------|-------------|
| 400 | invalid_request_error | Missing required fields |
| 401 | authentication_error | Invalid API key (NVIDIA-side) |
| 429 | rate_limit_error | All keys in cooldown / rate limited |
| 500 | internal_server_error | Upstream server error |
| 502 | bad_gateway | Upstream unavailable |
| 503 | service_unavailable | Service temporarily unavailable |

**Error Response Format:**
```json
{
  "error": {
    "message": "NVIDIA API error (429): Rate limit exceeded",
    "type": "rate_limit_error",
    "code": "429"
  }
}
```
