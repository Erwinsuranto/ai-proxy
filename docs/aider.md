# Aider Integration

Aider is an AI-powered coding assistant that can use this proxy as an API backend.

## Setup

### 1. Activate Virtual Environment

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 2. Install Aider

```bash
pip install aider-chat
```

### 3. Configure the Proxy

Start the proxy:

```bash
npm run dev
```

### 4. Run Aider

```bash
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=not-needed

aider --model openai/z-ai/glm-5.2
```

## Available Models

### openai/z-ai/glm-5.2

```bash
aider --model openai/z-ai/glm-5.2
```

Context: 256K tokens | Output: 16K tokens | Supports tools

### openai/deepseek-ai/deepseek-v4-flash

```bash
aider --model openai/deepseek-ai/deepseek-v4-flash
```

Fast inference | Optimized for code

### openai/deepseek-ai/deepseek-v4-pro

```bash
aider --model openai/deepseek-ai/deepseek-v4-pro
```

Higher quality | More capable

### openai/minimaxai/minimax-m2.7

```bash
aider --model openai/minimaxai/minimax-m2.7
```

MiniMax model | Good for general tasks

### openai/mistralai/mistral-medium-3.5-128b

```bash
aider --model openai/mistralai/mistral-medium-3.5-128b
```

Mistral Medium | High quality outputs

## Custom Model Metadata

Aider may warn about unknown models or token limits. To fix this, create a custom metadata file:

The file `.aider.model.metadata.json` in the project root defines model metadata:

```json
{
  "openai/z-ai/glm-5.2": {
    "max_tokens": 16384,
    "max_input_tokens": 262144,
    "max_output_tokens": 16384,
    "input_cost_per_token": 0.0,
    "output_cost_per_token": 0.0,
    "litellm_provider": "openai",
    "mode": "chat",
    "supports_function_calling": true,
    "supports_tool_choice": true,
    "supports_system_messages": true,
    "supports_streaming": true
  }
}
```

The file `.aider.model.settings.yml` configures edit behavior:

```yaml
- name: openai/z-ai/glm-5.2
  edit_format: diff
  weak_model_name: openai/z-ai/glm-5.2
  use_repo_map: true
  reminder: sys
  examples_as_sys_msg: true
```

Aider discovers these files automatically from the project root, git root, or home directory.

## Troubleshooting

### "Unknown model" warning

Create `.aider.model.metadata.json` with the model's token limits (see above).

### Token limit errors

Ensure `max_input_tokens` and `max_output_tokens` are set correctly in the metadata file.

### "command not found: aider"

Ensure the virtual environment is activated and Aider is installed:

```bash
source .venv/bin/activate
pip install aider-chat
```

### Slow responses

- Check network latency to the proxy
- Ensure `NVIDIA_BASE_URL` is geographically close
- Use streaming mode for faster first-token latency

### SSL errors

If the proxy runs on HTTP locally, ensure Aider doesn't try HTTPS:

```bash
export OPENAI_API_BASE=http://localhost:3000/v1
```
