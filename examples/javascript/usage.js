#!/usr/bin/env node
/**
 * NVIDIA API Proxy - JavaScript / Node.js Usage Examples
 *
 * Requirements:
 *   npm install openai
 *
 * Start the proxy first:
 *   npm run dev   # or: docker compose up -d
 */

import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "nvidia-api-proxy",
});

async function listModels() {
  console.log("=== List Models ===");
  const models = await client.models.list();
  for (const m of models.data) {
    console.log(`  ${m.id}`);
  }
  console.log();
}

async function chatNonStreaming() {
  console.log("=== Chat Completion (Non-Streaming) ===");
  const chat = await client.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Explain what NVIDIA API Proxy does in one sentence." },
    ],
    temperature: 0.7,
    max_tokens: 200,
  });
  console.log(`Response: ${chat.choices[0].message.content}`);
  console.log(`Usage:    ${JSON.stringify(chat.usage)}`);
  console.log();
}

async function chatStreaming() {
  console.log("=== Chat Completion (Streaming) ===");
  const stream = await client.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [{ role: "user", content: "Count from 1 to 10, with a brief pause between each." }],
    stream: true,
  });
  process.stdout.write("Stream: ");
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
  }
  console.log("\n");
}

async function embeddings() {
  console.log("=== Embeddings ===");
  const emb = await client.embeddings.create({
    model: "nvidia/nv-embedqa-e5-v5",
    input: "Hello world, this is a test embedding request.",
  });
  console.log(`Embedding dimension: ${emb.data[0].embedding.length}`);
  console.log(`Usage:               ${JSON.stringify(emb.usage)}`);
  console.log();
}

async function responsesApi() {
  console.log("=== Responses API (Non-Streaming) ===");
  const resp = await fetch("http://localhost:3000/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer nvidia-api-proxy",
    },
    body: JSON.stringify({
      model: "meta/llama-3.1-8b-instruct",
      input: "Explain what NVIDIA API Proxy does in one sentence.",
      temperature: 0.7,
      max_output_tokens: 200,
    }),
  });
  const data = await resp.json();
  let outputText = "";
  if (data.output) {
    for (const item of data.output) {
      if (item.type === "message") {
        for (const c of item.content || []) {
          if (c.type === "output_text") {
            outputText += c.text;
          }
        }
      }
    }
  }
  console.log(`Response: ${outputText}`);
  console.log(`Usage:    ${JSON.stringify(data.usage)}`);
  console.log();
}

async function responsesApiStreaming() {
  console.log("=== Responses API (Streaming) ===");
  const resp = await fetch("http://localhost:3000/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer nvidia-api-proxy",
    },
    body: JSON.stringify({
      model: "meta/llama-3.1-8b-instruct",
      input: "Count from 1 to 5.",
      stream: true,
    }),
  });
  process.stdout.write("Stream: ");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        if (trimmed === "data: [DONE]") break;
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.type === "response.text.delta") {
            process.stdout.write(data.delta);
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  }
  console.log("\n");
}

async function main() {
  try {
    await listModels();
    await chatNonStreaming();
    await chatStreaming();
    await embeddings();
    await responsesApi();
    await responsesApiStreaming();
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
