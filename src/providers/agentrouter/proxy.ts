// AgentRouter proxy mode. When enabled (AGENTROUTER_PROXY_MODE=true), requests
// and responses are forwarded verbatim — no body transformation. Only
// Authorization, timeout, retry and logging are managed. Endpoint selection
// still uses per-model metadata.

import { Protocol } from './types';

export class AgentRouterProxy {
  readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }
}