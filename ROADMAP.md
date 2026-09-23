# Roadmap

## Completed
- [x] OpenAI-compatible chat completions (streaming + non-streaming)
- [x] OpenAI-compatible embeddings
- [x] OpenAI-compatible model listing
- [x] OpenAI Responses API bridge
- [x] Internal monitoring endpoints
- [x] Round-robin API key distribution
- [x] Automatic failover and retry
- [x] Rate-limit cooldown and recovery
- [x] Per-key statistics tracking
- [x] Health checker (automatic cooldown refresh)
- [x] Docker multi-stage build
- [x] TypeScript strict mode
- [x] Comprehensive test suite

## Short-term
- [ ] Rate limiting per client IP
- [ ] Request/response caching for embeddings
- [ ] Prometheus metrics endpoint
- [ ] OpenAPI/Swagger documentation
- [ ] Kubernetes deployment manifests

## Medium-term
- [ ] Webhook notification for key cooldowns
- [ ] Admin dashboard for key management
- [ ] Load balancing strategy selection (round-robin, least-loaded, random)
- [ ] Automatic key rotation from external secret store
- [ ] Request logging to external storage (Elasticsearch, etc.)
- [ ] Health check customization per upstream provider

## Long-term
- [ ] Multi-provider support (AWS Bedrock, GCP Vertex AI, Azure OpenAI)
- [ ] Plugin system for custom middleware
- [ ] gRPC endpoint support
- [ ] Distributed mode with Redis-backed key state
- [ ] A/B testing framework for model comparison
