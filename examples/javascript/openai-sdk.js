import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'anything',
});

async function main() {
  // 1. List models
  console.log('=== Models ===');
  const models = await client.models.list();
  console.log(models.data.slice(0, 3));

  // 2. Chat completion
  console.log('\n=== Chat Completion ===');
  const chat = await client.chat.completions.create({
    model: 'meta/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: 'Say hello in one word.' }],
    temperature: 0.7,
    max_tokens: 50,
  });
  console.log(`Response: ${chat.choices[0].message.content}`);
  console.log(`Usage: ${JSON.stringify(chat.usage)}`);

  // 3. Streaming
  console.log('\n=== Streaming ===');
  const stream = await client.chat.completions.create({
    model: 'meta/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    stream: true,
  });
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
  console.log('\n');

  // 4. Embeddings
  console.log('=== Embeddings ===');
  const emb = await client.embeddings.create({
    model: 'nvidia/nv-embedqa-e5-v5',
    input: 'Hello world',
  });
  console.log(`Embedding dimension: ${emb.data[0].embedding.length}`);
  console.log(`Usage: ${JSON.stringify(emb.usage)}`);
}

main().catch(console.error);
