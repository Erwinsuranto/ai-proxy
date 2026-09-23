#!/usr/bin/env python3
"""
NVIDIA API Proxy - Python Usage Examples

Requirements:
    pip install openai

Start the proxy first:
    npm run dev   # or: docker compose up -d
"""

import httpx
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="nvidia-api-proxy",
)


def list_models():
    print("=== List Models ===")
    models = client.models.list()
    for m in models.data:
        print(f"  {m.id}")
    print()


def chat_non_streaming():
    print("=== Chat Completion (Non-Streaming) ===")
    chat = client.chat.completions.create(
        model="meta/llama-3.1-8b-instruct",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Explain what NVIDIA API Proxy does in one sentence."},
        ],
        temperature=0.7,
        max_tokens=200,
    )
    print(f"Response: {chat.choices[0].message.content}")
    print(f"Usage:     {chat.usage}")
    print()


def chat_streaming():
    print("=== Chat Completion (Streaming) ===")
    stream = client.chat.completions.create(
        model="meta/llama-3.1-8b-instruct",
        messages=[{"role": "user", "content": "Count from 1 to 10, with a brief pause between each."}],
        stream=True,
    )
    print("Stream: ", end="", flush=True)
    for chunk in stream:
        content = chunk.choices[0].delta.content or ""
        print(content, end="", flush=True)
    print("\n")


def embeddings():
    print("=== Embeddings ===")
    emb = client.embeddings.create(
        model="nvidia/nv-embedqa-e5-v5",
        input="Hello world, this is a test embedding request.",
    )
    print(f"Embedding dimension: {len(emb.data[0].embedding)}")
    print(f"Usage:               {emb.usage}")
    print()


def responses_api():
    print("=== Responses API (Non-Streaming) ===")
    resp = httpx.post(
        "http://localhost:3000/v1/responses",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer nvidia-api-proxy",
        },
        json={
            "model": "meta/llama-3.1-8b-instruct",
            "input": "Explain what NVIDIA API Proxy does in one sentence.",
            "temperature": 0.7,
            "max_output_tokens": 200,
        },
    )
    data = resp.json()
    output_text = ""
    if data.get("output"):
        for item in data["output"]:
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") == "output_text":
                        output_text += c["text"]
    print(f"Response: {output_text}")
    print(f"Usage:    {data.get('usage')}")
    print()


def responses_api_streaming():
    print("=== Responses API (Streaming) ===")
    with httpx.stream(
        "POST",
        "http://localhost:3000/v1/responses",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer nvidia-api-proxy",
        },
        json={
            "model": "meta/llama-3.1-8b-instruct",
            "input": "Count from 1 to 5.",
            "stream": True,
        },
    ) as resp:
        print("Stream: ", end="", flush=True)
        for line in resp.iter_lines():
            if line.startswith("data: "):
                if line == "data: [DONE]":
                    break
                try:
                    import json
                    data = json.loads(line[6:])
                    if data.get("type") == "response.text.delta":
                        print(data["delta"], end="", flush=True)
                except json.JSONDecodeError:
                    pass
    print("\n")


def main():
    list_models()
    chat_non_streaming()
    chat_streaming()
    embeddings()
    responses_api()
    responses_api_streaming()


if __name__ == "__main__":
    main()
