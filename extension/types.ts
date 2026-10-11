export type Tier = 'frontier' | 'balanced' | 'small' | 'free';
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
  agenticScore: number;
  /** Measured benchmark power of the model (0..1); undefined when no snapshot covers it. */
  benchmarkPower?: number;
  /**
   * Quality with the overall Intelligence Index standing in for coding+agentic; undefined when the
   * snapshot has no intelligence index. Only used to compare a set that includes a route whose
   * coding index is not published yet (see ranking.ts `qualityBasis`).
   */
  intelligenceQualityScore?: number;
  /** Whether the snapshot carries a coding index for this model. */
  codingMeasured?: boolean;
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
