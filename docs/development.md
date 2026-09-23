# Development

## Prerequisites

- Node.js 20+
- npm 9+
- An NVIDIA API key (for integration testing)

## Quick Start

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000` with hot-reload enabled.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production server |
| `npm run dev` | Development server with hot-reload |
| `npm test` | Run all tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | Type-check without emitting |
| `npm run verify:nvidia` | Verify NVIDIA API connectivity |

## Workflow

1. Start the dev server: `npm run dev`
2. Make changes to `.ts` files in `src/`
3. Hot-reload automatically recompiles
4. Test with curl or the test suite:
   ```bash
   curl http://localhost:3000/health
   npm test
   ```
5. Before committing, ensure `npm run build` and `npm test` pass

## Testing with Real API

To test against the real NVIDIA API, set your key in `.env`:

```env
NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then run:

```bash
npm test
```

The test suite will run integration tests against the real API (chat, streaming, embeddings, models).

## Debug Mode

Set `DEBUG=true` in `.env` to enable verbose request/response logging.

Set `DEBUG_TOOL_CALL=true` to debug tool call payloads (writes to stderr).

## Adding a New Route

1. Create file in `src/routes/`
2. Implement Fastify route plugin (export `async function`)
3. Register in `src/server.ts` via `app.register()`
4. Add tests in `tests/`

## Adding a New Provider Method

1. Add method to `NvidiaProvider` class in `src/lib/provider.ts`
2. Add facade method in `src/services/nvidia.ts`
3. Call from route handler
