/**
 * Virtual `pmr/*` models: the only opt-in surface for managed routing.
 * See docs/spec-virtual-model-routing.md §2–§3.
 *
 * The registered provider is intentionally fake: baseUrl is the TCP discard
 * port and must never be contacted. A request reaching it means the router
 * failed to switch away — the before_provider_request guard in index.ts
 * aborts the turn (spec §4) instead of burning OMP's 10 auto-retries.
 */

export type RoutingMode = 'manual' | 'frontier' | 'balanced' | 'small' | 'free';

export const VIRTUAL_PROVIDER = 'pmr';

export const PLACEHOLDER_API_KEY = 'not-a-real-credential';

export const VIRTUAL_MODELS = [
  { id: 'frontier', name: 'PMR: Frontier' },
  { id: 'balanced', name: 'PMR: Balanced' },
  { id: 'small', name: 'PMR: Small' },
  { id: 'free', name: 'PMR: Free' },
] as const;

export type ManagedMode = Exclude<RoutingMode, 'manual'>;

export function virtualModeForModelKey(key: string | undefined): ManagedMode | undefined {
  if (typeof key !== 'string' || !key.startsWith(`${VIRTUAL_PROVIDER}/`)) return undefined;
  const id = key.slice(VIRTUAL_PROVIDER.length + 1);
  if (id === 'frontier' || id === 'balanced' || id === 'small' || id === 'free') return id;
  return undefined;
}

export function resolveModeTransition(
  current: RoutingMode,
  currentKey: string | undefined,
  lastRouterSelected: string | undefined,
): RoutingMode {
  const managed = virtualModeForModelKey(currentKey);
  if (managed) return managed;
  if (current !== 'manual' && currentKey !== undefined && currentKey === lastRouterSelected) return current;
  return 'manual';
}

interface RegisterProviderLike {
  registerProvider(name: string, config: Record<string, unknown>, sourceId: string): void;
}

export function registerVirtualRouterProvider(pi: unknown): void {
  const api = pi as RegisterProviderLike;
  api.registerProvider(
    VIRTUAL_PROVIDER,
    {
      name: 'Router (adaptive)',
      // Discard port: never contacted. If a request reaches it, the guard aborts.
      baseUrl: 'http://127.0.0.1:9',
      // OMP 18.2.6 runtime-register validation requires an apiKey when static
      // models are defined (spec §1 fact F2). This is a constant, not a secret.
      apiKey: PLACEHOLDER_API_KEY,
      models: VIRTUAL_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        api: 'openai-completions',
        supportsTools: true,
      })),
    },
    'pmr',
  );
}
