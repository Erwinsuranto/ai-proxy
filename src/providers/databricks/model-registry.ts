import { EndpointManager } from '../../lib/endpoint-manager';

export interface EndpointModelSummary {
  endpointIndex: number;
  endpointName: string;
  healthy: boolean;
  lastRefresh: number | null;
  modelCount: number;
}

export interface ModelInfo {
  id: string;
  endpointIndices: number[];
}

export class ModelRegistry {
  private models: Map<string, Set<number>> = new Map();
  private endpointHealthy: Map<number, boolean> = new Map();
  private endpointLastRefresh: Map<number, number> = new Map();
  private endpointNames: Map<number, string> = new Map();

  constructor(private endpointManager: EndpointManager) {
    for (let i = 0; i < endpointManager.endpointCount; i++) {
      const info = endpointManager.getEndpointInfo(i);
      this.endpointNames.set(i, shortUrl(info.baseUrl));
      this.endpointHealthy.set(i, false);
    }
  }

  getModelEndpoints(modelId: string): number[] {
    const endpoints = this.models.get(modelId);
    if (!endpoints || endpoints.size === 0) return [];
    return [...endpoints];
  }

  getAllModels(): string[] {
    return [...this.models.keys()];
  }

  getEndpointModelCount(index: number): number {
    let count = 0;
    for (const endpoints of this.models.values()) {
      if (endpoints.has(index)) count++;
    }
    return count;
  }

  getEndpointSummary(index: number): EndpointModelSummary {
    return {
      endpointIndex: index,
      endpointName: this.endpointNames.get(index) ?? `Endpoint #${index + 1}`,
      healthy: this.endpointHealthy.get(index) ?? false,
      lastRefresh: this.endpointLastRefresh.get(index) ?? null,
      modelCount: this.getEndpointModelCount(index),
    };
  }

  getAllEndpointSummaries(): EndpointModelSummary[] {
    const result: EndpointModelSummary[] = [];
    for (let i = 0; i < this.endpointManager.endpointCount; i++) {
      result.push(this.getEndpointSummary(i));
    }
    return result;
  }

  startBackgroundRefresh(_intervalMs: number = 600_000): void {
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split('.');
    if (parts.length >= 2) return parts[0] + '...';
    return parsed.hostname.slice(0, 8) + '...';
  } catch {
    return url.length > 8 ? url.slice(0, 8) + '...' : url;
  }
}
