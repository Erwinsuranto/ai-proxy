# NVIDIA API Integration Guide

## Base URL

```
https://integrate.api.nvidia.com/v1
```

## Authentication

```
Authorization: Bearer nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Dapatkan API Key dari [build.nvidia.com](https://build.nvidia.com).

## Endpoint yang Digunakan

| Endpoint | Method | Keterangan |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completion (non-streaming & streaming) |
| `/v1/models` | GET | Daftar model yang tersedia |
| `/v1/embeddings` | POST | Generate embeddings (model spesifik) |

> **Catatan**: NVIDIA NIM API sudah **OpenAI-compatible**. Request dan response format sama persis dengan OpenAI API.

---

## Chat Completions

### Request

```json
{
  "model": "meta/llama-3.3-70b-instruct",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 0.95,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "stop": null,
  "stream": false
}
```

**Parameter Wajib**:
- `model` - ID model (contoh: `meta/llama-3.3-70b-instruct`)
- `messages` - Array pesan (role: system/user/assistant)
- `max_tokens` - **WAJIB** menurut dokumentasi NVIDIA

### Response (Non-Streaming)

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "meta/llama-3.3-70b-instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

### Response (Streaming / SSE)

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"...","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## Models

### Request

```
GET /v1/models
Authorization: Bearer nvapi-xxx
```

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "meta/llama-3.3-70b-instruct",
      "object": "model",
      "created": 1735689600,
      "owned_by": "meta"
    }
  ]
}
```

---

## Embeddings

### Request

```json
{
  "model": "nvidia/nv-embedqa-e5-v5",
  "input": "Hello world",
  "encoding_format": "float"
}
```

**Parameter NVIDIA-specific** (opsional):
- `input_type` - `"passage"` atau `"query"` (untuk asymmetric retrieval)
- `truncate` - `"NONE"` atau `"END"`
- `dimensions` - jumlah dimensi (untuk model yang mendukung reduksi)

### Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.001, -0.002, ...]
    }
  ],
  "model": "nvidia/nv-embedqa-e5-v5",
  "usage": {
    "prompt_tokens": 3,
    "total_tokens": 3
  }
}
```

---

## Model Mapping

NVIDIA menggunakan format `{provider}/{model-name}`:
- `meta/llama-3.3-70b-instruct`
- `mistralai/mistral-large-2-instruct`
- `nvidia/llama-3.1-nemotron-70b-instruct`
- `deepseek-ai/deepseek-v4-flash`
- `google/gemma-2-27b-it`
- `microsoft/phi-3.5-moe-instruct`

Daftar lengkap: `GET /v1/models`

---

## Proxy Mapping

| Proxy Request | Forward ke NVIDIA |
|---|---|
| `Authorization: Bearer anything` | `Authorization: Bearer ${NVIDIA_API_KEY}` |
| `POST /v1/chat/completions` | `POST /v1/chat/completions` |
| `POST /v1/embeddings` | `POST /v1/embeddings` |
| `GET /v1/models` | `GET /v1/models` |

---

## Troubleshooting

### 401 Unauthorized
- Pastikan `NVIDIA_API_KEY` valid
- Cek di https://build.nvidia.com
- API Key biasanya diawali `nvapi-`

### max_tokens required
NVIDIA mewajibkan `max_tokens`. Proxy otomatis mengisi default `2048` jika tidak dikirim.

### Models tidak muncul
- Cek koneksi ke `https://integrate.api.nvidia.com/v1/models`
- Jika NVIDIA API tidak reachable, proxy fallback ke `config/models.json`

### Debug Mode
Set `DEBUG=true` di `.env` untuk melihat request/response ke NVIDIA:
```
[NVIDIA REQ] POST /chat/completions
[NVIDIA REQ] Authorization: Bearer nvap***xxxx
[NVIDIA RES] 200 /chat/completions
```

### Streaming lambat
- `TIMEOUT` di `.env` mengontrol timeout koneksi (default: 120000 ms)
- Streaming menggunakan SSE (Server-Sent Events)

### Retry
Proxy akan retry otomatis 3x untuk error 500+ dengan exponential backoff:
- Attempt 1: tunggu 1 detik
- Attempt 2: tunggu 2 detik
- Attempt 3: tunggu 4 detik
