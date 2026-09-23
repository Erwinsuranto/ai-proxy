# Contributing

This document provides detailed guidance for contributors.

## Development Setup

```bash
git clone https://github.com/your-org/nvidia-api-proxy.git
cd nvidia-api-proxy
npm install
cp .env.example .env
# Edit .env with your NVIDIA API key
```

## Development Server

```bash
npm run dev
```

Starts with hot-reload via `tsx watch`.

## Project Structure

```
src/
├── config.ts          # Environment configuration
├── server.ts          # Fastify entry point + health checker
├── lib/
│   ├── app-state.ts   # Shared state (start time)
│   ├── key-manager.ts # Round-robin + cooldown + health
│   ├── logger.ts      # Console logging utilities
│   ├── provider.ts    # HTTP client with retry/failover
│   ├── retry.ts       # Error classification
│   └── stats.ts       # Per-key statistics
├── routes/
│   ├── chat.ts        # POST /v1/chat/completions
│   ├── embeddings.ts  # POST /v1/embeddings
│   ├── internal.ts    # GET /internal/*
│   ├── models.ts      # GET /v1/models
│   └── responses.ts   # POST /v1/responses
├── services/
│   └── nvidia.ts      # Provider facade (singleton)
└── utils/
    ├── openaiResponse.ts  # OpenAI-compatible formatters
    └── responses.ts       # Responses API converters
```

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:integration  # Verbose output
```

Tests are in `tests/` using Vitest. The test suite starts the compiled server as a child process on port 3456, waits for it to be healthy, then runs HTTP-based integration tests.

## Code Style

- TypeScript strict mode enabled
- No semicolons in import statements? — Project uses them consistently
- Use `async/await` for asynchronous code
- Export interfaces and types for public APIs
- Prefer `const` over `let`
- Handle errors with try/catch and structured logging
