export type Tier = 'frontier' | 'balanced' | 'small';
export type RouteState = 'AVAILABLE' | 'DRAINING' | 'COOLDOWN';
export type Freshness = 'FRESH' | 'STALE' | 'UNKNOWN';

export interface PriceVector {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RouteHealth {
  state: RouteState;
  freshness: Freshness;
  cooldownUntil?: number;
  reason?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface NormalizedRoute {
  key: string;
  provider: string;
  modelId: string;
  selector: string;
  name?: string;
  classes: string[];
  free: boolean;
  subscriptionLike: boolean;
  price: PriceVector;
  health: RouteHealth;
  qualityScore: number;
  reliabilityScore: number;
  latencyMs?: number;
  throughput?: number;
}

export interface TierPolicy {
  classes: string[];
}

export interface RouterPolicy {
  tiers: Record<Tier, TierPolicy>;
}

export interface SessionIdentity {
  agent?: string;
}
