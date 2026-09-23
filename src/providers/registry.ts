import { Provider, ProviderInfo } from '../lib/types';
import { modelRegistry } from '../lib/model-registry';
import { saveProviderState } from '../lib/provider-state';
import { providerRefreshCooldown, createProviderRefreshCooldownError } from '../lib/provider-refresh-cooldown';

export interface RegisteredProvider {
  identity: ProviderInfo;
  instance: Provider;
}

class ProviderRegistry {
  private providers: RegisteredProvider[] = [];
  private providerMap: Map<string, RegisteredProvider> = new Map();
  private disabledSet: Set<string> = new Set();

  register(identity: ProviderInfo, instance: Provider): void {
    const wrapRefresh = <T extends (...args: any[]) => Promise<any>>(method: T): T => {
      return (async (...args: any[]) => {
        const decision = providerRefreshCooldown.tryStart(identity.providerId);
        if (!decision.allowed) {
          throw createProviderRefreshCooldownError(identity.providerId, decision.remainingMs);
        }
        try {
          return await method.apply(instance, args);
        } finally {
          providerRefreshCooldown.finish(identity.providerId);
        }
      }) as T;
    };
    instance.listModels = wrapRefresh(instance.listModels);
    if (instance.healthCheck) instance.healthCheck = wrapRefresh(instance.healthCheck);
    const entry: RegisteredProvider = { identity, instance };
    this.providers.push(entry);
    this.providerMap.set(identity.providerId, entry);
  }

  setDisabled(ids: string[]): void {
    this.disabledSet = new Set(ids);
  }

  isDisabled(id: string): boolean {
    return this.disabledSet.has(id);
  }

  getDisabledProviders(): string[] {
    return Array.from(this.disabledSet).filter(id => this.providerMap.has(id));
  }

  getEnabledProviderIds(): string[] {
    return this.providers
      .filter(p => !this.disabledSet.has(p.identity.providerId))
      .map(p => p.identity.providerId);
  }

  getProviderForModel(model: string): RegisteredProvider | undefined {
    const registrations = modelRegistry.getProvidersForModel(model);
    if (registrations.length === 0) return undefined;
    const firstEnabled = registrations[0];
    return this.getProviderById(firstEnabled.providerId);
  }

  getProvidersForModel(model: string): RegisteredProvider[] {
    const registrations = modelRegistry.getProvidersForModel(model);
    const result: RegisteredProvider[] = [];
    for (const reg of registrations) {
      const rp = this.getProviderById(reg.providerId);
      if (rp) result.push(rp);
    }
    return result;
  }

  getProviderById(id: string): RegisteredProvider | undefined {
    if (this.disabledSet.has(id)) return undefined;
    return this.providerMap.get(id);
  }

  /**
   * Lookup that ALSO returns disabled providers. Used by discovery/registration
   * paths so a disabled provider stays known to the system (its models remain
   * in the registry), while request routing keeps using getProviderById() which
   * excludes disabled providers.
   */
  getProviderByIdAllowDisabled(id: string): RegisteredProvider | undefined {
    return this.providerMap.get(id);
  }

  getAllProviders(): RegisteredProvider[] {
    return [...this.providers];
  }

  getAllConfiguredProviders(): RegisteredProvider[] {
    return this.providers.filter(p => !this.disabledSet.has(p.identity.providerId));
  }

  getAllProviderIds(): string[] {
    return this.providers
      .filter(p => !this.disabledSet.has(p.identity.providerId))
      .map(p => p.identity.providerId);
  }

  /** Clears all registered providers and disabled state (used by tests). */
  reset(): void {
    for (const id of this.providerMap.keys()) providerRefreshCooldown.clear(id);
    this.providers = [];
    this.providerMap.clear();
    this.disabledSet.clear();
  }

  isConfigured(id: string): boolean {
    if (this.disabledSet.has(id)) return false;
    return this.providerMap.has(id);
  }

  disableProvider(id: string): boolean {
    if (!this.providerMap.has(id)) return false;
    this.disabledSet.add(id);
    saveProviderState(this.getDisabledProviders());
    return true;
  }

  enableProvider(id: string): boolean {
    if (!this.providerMap.has(id)) return false;
    this.disabledSet.delete(id);
    saveProviderState(this.getDisabledProviders());
    return true;
  }
}

export const registry = new ProviderRegistry();
