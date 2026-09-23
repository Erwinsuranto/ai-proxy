# Contributing

We welcome contributions! Please follow these guidelines.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/api-proxy.git`
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and configure your NVIDIA API key
5. Start development server: `npm run dev`

## Development Workflow

1. Create a feature branch: `git checkout -b feat/my-feature`
2. Make your changes
3. Ensure TypeScript compiles: `npm run build`
4. Ensure all tests pass: `npm test`
5. Add tests for new functionality
6. Commit with a clear message describing the change
7. Push and open a Pull Request

## Code Style

- Use TypeScript with strict mode
- Follow existing patterns for consistency
- Add JSDoc comments for public APIs
- Use async/await over raw promises
- Prefer `const` over `let`
- Use meaningful variable names

## Testing

- All new features should include tests
- Run `npm test` before submitting
- Tests use Vitest (see `vitest.config.ts`)
- Test server starts on port 3456 automatically

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Reference any related issues
- Update documentation if needed
- Ensure CI passes

## Code of Conduct

Please note that this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you agree to uphold its standards.
