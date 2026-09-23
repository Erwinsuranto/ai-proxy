#!/usr/bin/env bash
#===============================================================================
# NVIDIA API Proxy — Aider Usage Examples
#
# Prerequisites:
#   1. Start the proxy:   npm run dev   (or docker compose up -d)
#   2. Activate virtualenv with aider installed
#
# This script demonstrates how to use aider with the NVIDIA API Proxy.
#===============================================================================
set -euo pipefail

echo "=============================================="
echo "  NVIDIA API Proxy — Aider Examples"
echo "=============================================="
echo ""

# ------------------------------------------------------------------
# 1. Activate virtualenv (adjust path to your environment)
# ------------------------------------------------------------------
echo "# --- Activate virtualenv ---"
echo "python3 -m venv .venv"
echo "source .venv/bin/activate"
echo "pip install aider-chat"
echo ""

# ------------------------------------------------------------------
# 2. Set environment variables for the proxy
# ------------------------------------------------------------------
echo "# --- Set environment variables ---"
echo 'export OPENAI_API_BASE="http://localhost:3000/v1"'
echo 'export OPENAI_API_KEY="api-proxy-proxy"'
echo ""

# ------------------------------------------------------------------
# 3. Run aider with specific models
# ------------------------------------------------------------------
echo "# --- Run aider with z-ai/glm-5.2 (diff edit format) ---"
echo "aider \\"
echo '  --model "openai/z-ai/glm-5.2" \\'
echo '  --edit-format diff \\'
echo '  --no-show-model-warnings'
echo ""

echo "# --- Run aider with deepseek-ai/deepseek-v4-flash ---"
echo "aider \\"
echo '  --model "openai/deepseek-ai/deepseek-v4-flash" \\'
echo '  --edit-format diff \\'
echo '  --no-show-model-warnings'
echo ""

echo "# --- Run aider with deepseek-ai/deepseek-v4-pro ---"
echo "aider \\"
echo '  --model "openai/deepseek-ai/deepseek-v4-pro" \\'
echo '  --edit-format diff \\'
echo '  --no-show-model-warnings'
echo ""

echo "# --- Run aider with minimaxai/minimax-m2.7 ---"
echo "aider \\"
echo '  --model "openai/minimaxai/minimax-m2.7" \\'
echo '  --edit-format diff \\'
echo '  --no-show-model-warnings'
echo ""

echo "# --- Run aider with mistralai/mistral-medium-3.5-128b ---"
echo "aider \\"
echo '  --model "openai/mistralai/mistral-medium-3.5-128b" \\'
echo '  --edit-format diff \\'
echo '  --no-show-model-warnings'
echo ""

# ------------------------------------------------------------------
# 4. One-liner examples (after env vars are set)
# ------------------------------------------------------------------
echo "# --- Quick one-liner (env vars already exported above) ---"
echo "aider --model openai/z-ai/glm-5.2 --edit-format diff"
echo ""

echo "# --- One-liner with inline env vars ---"
echo 'OPENAI_API_BASE="http://localhost:3000/v1" \
  OPENAI_API_KEY="api-proxy-proxy" \
  aider --model openai/deepseek-ai/deepseek-v4-flash --edit-format diff'
echo ""

echo "# --- Run aider with architect mode (deepseek-v4-flash as editor) ---"
echo "aider \\"
echo '  --model "openai/deepseek-ai/deepseek-v4-flash" \\'
echo '  --edit-format diff \\'
echo '  --architect \\'
echo '  --no-show-model-warnings'
echo ""

echo "=============================================="
echo "  Done. Copy/paste any command above to run it."
echo "=============================================="
