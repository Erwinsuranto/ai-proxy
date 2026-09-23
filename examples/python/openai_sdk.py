from openai import OpenAI

client = OpenAI(
    base_url='http://localhost:3000/v1',
    api_key='anything',
)


def main():
    # 1. List models
    print('=== Models ===')
    models = client.models.list()
    for m in models.data[:3]:
        print(f"  {m.id}")

    # 2. Chat completion
    print('\n=== Chat Completion ===')
    chat = client.chat.completions.create(
        model='meta/llama-3.3-70b-instruct',
        messages=[{'role': 'user', 'content': 'Say hello in one word.'}],
        temperature=0.7,
        max_tokens=50,
    )
    print(f"Response: {chat.choices[0].message.content}")
    print(f"Usage: {chat.usage}")

    # 3. Streaming
    print('\n=== Streaming ===')
    stream = client.chat.completions.create(
        model='meta/llama-3.3-70b-instruct',
        messages=[{'role': 'user', 'content': 'Count from 1 to 5.'}],
        stream=True,
    )
    for chunk in stream:
        content = chunk.choices[0].delta.content or ''
        print(content, end='')
    print()

    # 4. Embeddings
    print('\n=== Embeddings ===')
    emb = client.embeddings.create(
        model='nvidia/nv-embedqa-e5-v5',
        input='Hello world',
    )
    print(f"Embedding dimension: {len(emb.data[0].embedding)}")
    print(f"Usage: {emb.usage}")


if __name__ == '__main__':
    main()
