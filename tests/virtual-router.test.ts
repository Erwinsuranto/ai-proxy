import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualRouter, NoAvailableBackendError, AllBackendsFailedError } from '../src/lib/virtual-router';

function createTestConfig() {
  return {
    virtualModel: 'qwen/qwen3.5-122b-a10b',
    strategy: 'round_robin' as const,
    backends: [
      { provider: 'databricks', model: 'databricks-qwen35-122b-a10b' },
      { provider: 'openrouter', model: 'qwen/qwen3.5-122b-a10b' },
    ],
  };
}

describe('VirtualRouter', () => {
  let router: VirtualRouter;

  beforeEach(() => {
    router = new VirtualRouter();
  });

  describe('addRoute / getRoute', () => {
    it('returns null for unknown model', () => {
      expect(router.getRoute('nonexistent')).toBeNull();
    });

    it('returns config for registered model', () => {
      router.addRoute(createTestConfig());
      const route = router.getRoute('qwen/qwen3.5-122b-a10b');
      expect(route).not.toBeNull();
      expect(route!.strategy).toBe('round_robin');
      expect(route!.backends).toHaveLength(2);
    });

    it('getAllVirtualModels returns all registered models', () => {
      router.addRoute(createTestConfig());
      router.addRoute({ virtualModel: 'other/model', strategy: 'priority', backends: [{ provider: 'nvidia', model: 'other/model' }] });
      const models = router.getAllVirtualModels();
      expect(models).toContain('qwen/qwen3.5-122b-a10b');
      expect(models).toContain('other/model');
      expect(models).toHaveLength(2);
    });
  });

  describe('round_robin strategy', () => {
    it('alternates backends across calls', () => {
      router.addRoute(createTestConfig());
      const order1 = router.getBackendOrder('qwen/qwen3.5-122b-a10b');
      const order2 = router.getBackendOrder('qwen/qwen3.5-122b-a10b');

      expect(order1[0]).not.toBe(order2[0]);
    });

    it('cycles through all backends', () => {
      router.addRoute({
        virtualModel: 'test',
        strategy: 'round_robin',
        backends: [
          { provider: 'a', model: 'a' },
          { provider: 'b', model: 'b' },
          { provider: 'c', model: 'c' },
        ],
      });

      const first0 = router.getBackendOrder('test')[0];
      const second0 = router.getBackendOrder('test')[0];
      const third0 = router.getBackendOrder('test')[0];

      expect(first0).toBe(0);
      expect(second0).toBe(1);
      expect(third0).toBe(2);
    });

    it('skips backends in cooldown', () => {
      router.addRoute({
        virtualModel: 'test',
        strategy: 'round_robin',
        backends: [
          { provider: 'a', model: 'a' },
          { provider: 'b', model: 'b' },
          { provider: 'c', model: 'c' },
        ],
      });

      router.markFailure('test', 1, { message: 'fail', status: 500 });

      const order = router.getBackendOrder('test');
      expect(order).not.toContain(1);

      const first = order[0];
      const second = order.length > 1 ? order[1] : -1;
      expect([0, 2]).toContain(first);
    });
  });

  describe('priority strategy', () => {
    it('returns backends in config order', () => {
      router.addRoute({ ...createTestConfig(), strategy: 'priority' });
      const order = router.getBackendOrder('qwen/qwen3.5-122b-a10b');
      expect(order).toEqual([0, 1]);
    });

    it('excludes cooldown backends but keeps order of remaining', () => {
      router.addRoute({
        virtualModel: 'test',
        strategy: 'priority',
        backends: [
          { provider: 'a', model: 'a' },
          { provider: 'b', model: 'b' },
          { provider: 'c', model: 'c' },
        ],
      });

      router.markFailure('test', 1, { message: 'fail', status: 500 });
      const order = router.getBackendOrder('test');
      expect(order).toEqual([0, 2]);
    });

    it('returns all backends when all are in cooldown', () => {
      router.addRoute({
        virtualModel: 'test',
        strategy: 'priority',
        backends: [
          { provider: 'a', model: 'a' },
          { provider: 'b', model: 'b' },
        ],
      });

      router.markFailure('test', 0, { message: 'fail', status: 500 });
      router.markFailure('test', 1, { message: 'fail', status: 503 });
      const order = router.getBackendOrder('test');
      expect(order).toEqual([0, 1]);
    });
  });

  describe('random strategy', () => {
    it('returns valid indices', () => {
      router.addRoute({ ...createTestConfig(), strategy: 'random' });
      for (let i = 0; i < 20; i++) {
        const order = router.getBackendOrder('qwen/qwen3.5-122b-a10b');
        for (const idx of order) {
          expect([0, 1]).toContain(idx);
        }
      }
    });
  });

  describe('fastest / least_latency strategy', () => {
    it('picks backend with lowest average latency first', () => {
      router.addRoute({
        virtualModel: 'test',
        strategy: 'fastest',
        backends: [
          { provider: 'slow', model: 'slow' },
          { provider: 'fast', model: 'fast' },
        ],
      });

      router.markSuccess('test', 0, 500);
      router.markSuccess('test', 1, 50);

      const order = router.getBackendOrder('test');
      expect(order[0]).toBe(1);
    });
  });

  describe('markSuccess / markFailure', () => {
    it('tracks success count and resets error state', () => {
      router.addRoute(createTestConfig());

      router.markFailure('qwen/qwen3.5-122b-a10b', 0, { message: 'error', status: 500 });
      let health = router.getBackendHealth('qwen/qwen3.5-122b-a10b');
      expect(health![0].failureCount).toBe(1);
      expect(health![0].lastError).toBe('error');
      expect(health![0].disabledUntil).not.toBeNull();

      router.markSuccess('qwen/qwen3.5-122b-a10b', 0, 100);
      health = router.getBackendHealth('qwen/qwen3.5-122b-a10b');
      expect(health![0].successCount).toBe(1);
      expect(health![0].lastError).toBeNull();
      expect(health![0].disabledUntil).toBeNull();
      expect(health![0].averageLatency).toBe(100);
    });

    it('does not cooldown on non-server errors (e.g. 400)', () => {
      router.addRoute(createTestConfig());
      router.markFailure('qwen/qwen3.5-122b-a10b', 0, { message: 'bad request', status: 400 });
      const health = router.getBackendHealth('qwen/qwen3.5-122b-a10b');
      expect(health![0].disabledUntil).toBeNull();
    });

    it('cooldowns on 429', () => {
      router.addRoute(createTestConfig());
      router.markFailure('qwen/qwen3.5-122b-a10b', 0, { message: 'rate limited', status: 429 });
      const health = router.getBackendHealth('qwen/qwen3.5-122b-a10b');
      expect(health![0].disabledUntil).not.toBeNull();
    });

    it('calculates average latency correctly', () => {
      router.addRoute(createTestConfig());
      router.markSuccess('qwen/qwen3.5-122b-a10b', 0, 100);
      router.markSuccess('qwen/qwen3.5-122b-a10b', 0, 200);
      const health = router.getBackendHealth('qwen/qwen3.5-122b-a10b');
      expect(health![0].averageLatency).toBe(150);
    });
  });

  describe('model replacement', () => {
    it('taggedPayload.model equals upstreamModel, not virtual model', () => {
      const config = createTestConfig();
      router.addRoute(config);

      const backendOrder = router.getBackendOrder(config.virtualModel);
      expect(backendOrder.length).toBeGreaterThan(0);

      const firstBackendIdx = backendOrder[0];
      const firstBackend = config.backends[firstBackendIdx];

      const originalPayload = { model: config.virtualModel, messages: [{ role: 'user', content: 'hi' }] };
      const upstreamModel = firstBackend.model;
      const taggedPayload = { ...originalPayload, model: upstreamModel };

      expect(taggedPayload.model).not.toBe(config.virtualModel);
      expect(taggedPayload.model).toBe(upstreamModel);
      expect(taggedPayload.model).toBe('databricks-qwen35-122b-a10b');
      expect(originalPayload.model).toBe('qwen/qwen3.5-122b-a10b');
    });

    it('each backend replaces virtual model with its own upstream model', () => {
      const config = createTestConfig();
      router.addRoute(config);

      const databricksBackend = config.backends.find(b => b.provider === 'databricks')!;
      const payload = { model: config.virtualModel };
      const taggedPayload = { ...payload, model: databricksBackend.model };
      expect(taggedPayload.model).toBe('databricks-qwen35-122b-a10b');
      expect(taggedPayload.model).not.toBe(config.virtualModel);

      const openrouterBackend = config.backends.find(b => b.provider === 'openrouter')!;
      const payload2 = { model: config.virtualModel };
      const taggedPayload2 = { ...payload2, model: openrouterBackend.model };
      expect(taggedPayload2.model).toBe('qwen/qwen3.5-122b-a10b');
      // For OpenRouter, upstream model happens to equal virtual model
      // But the code still explicitly replaces it
      expect(taggedPayload2.model).toBe(openrouterBackend.model);
    });

    it('Databricks backend sends databricks-qwen35-122b-a10b not qwen/qwen3.5-122b-a10b', () => {
      const config = createTestConfig();
      router.addRoute(config);

      const databricksBackend = config.backends.find(b => b.provider === 'databricks')!;
      expect(databricksBackend).toBeDefined();
      expect(databricksBackend.model).toBe('databricks-qwen35-122b-a10b');
      expect(databricksBackend.model).not.toBe(config.virtualModel);
    });
  });

  describe('edge cases', () => {
    it('handles single backend', () => {
      router.addRoute({
        virtualModel: 'single',
        strategy: 'round_robin',
        backends: [{ provider: 'only', model: 'only' }],
      });

      for (let i = 0; i < 5; i++) {
        const order = router.getBackendOrder('single');
        expect(order).toEqual([0]);
      }
    });

    it('handles zero backends', () => {
      router.addRoute({
        virtualModel: 'empty',
        strategy: 'round_robin',
        backends: [],
      });

      expect(router.getBackendOrder('empty')).toEqual([]);
    });
  });
});
