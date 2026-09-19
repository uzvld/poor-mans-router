import type { NormalizedRoute, SessionIdentity, Tier } from './types.ts';
import type { SelectionResult } from './ranking.ts';

export type ResourcePressure = 'normal' | 'draining' | 'critical';

export function latestSessionIdentity(branch: readonly any[]): SessionIdentity {
  let latest: SessionIdentity = {};
  for (const entry of branch ?? []) {
    if (entry?.type !== 'session_init') continue;
    latest = {
      agent: typeof entry.agent === 'string' ? entry.agent : undefined,
    };
  }
  return latest;
}

export function pressureForSelection(selection: SelectionResult | undefined): ResourcePressure {
  if (!selection) return 'critical';
  return selection.route.health.state === 'DRAINING' ? 'draining' : 'normal';
}

export function pressureMessage(pressure: ResourcePressure): string | undefined {
  if (pressure === 'draining') {
    return '[resource-pressure: draining]\nFinish the current atomic step, reduce new fan-out, and avoid opening broad new work branches.';
  }
  if (pressure === 'critical') {
    return '[resource-pressure: critical]\nValidate and persist current progress, summarize remaining work, and avoid starting a new phase.';
  }
  return undefined;
}

/**
 * One-line switch marker for the session transcript, in the same `[omp:<tag>]` shape hosts
 * use for tool calls. Delivered through `ctx.ui.notify`, which OMP forwards to RPC hosts as
 * `extension_ui_request{method:"notify"}`; hosts opt `[omp:`-prefixed messages into output.
 */
export function switchMarker(from: string, to: string, reason?: string): string {
  return `[omp:pmr] ${from} -> ${to} (${reason && reason.length > 0 ? reason : 'routing decision'})`;
}

/**
 * Held-switch marker, same `[omp:pmr]` channel as `switchMarker` so RPC hosts opt it
 * into the transcript. A silent hold is indistinguishable from a dead router.
 */
export function holdMarker(current: string, wanted: string, reason?: string): string {
  const why = reason && reason.length > 0 ? reason : 'context would not survive the switch';
  return `[omp:pmr] switch held: staying on ${current} instead of ${wanted} (${why})`;
}

export function allowDrainingForTier(tier: Tier): boolean {
  // Frontier is the first class of new work denied access to scarce/degraded capacity.
  // Balanced can keep using degraded routes long enough to finish useful work; small lasts longest.
  return tier !== 'frontier';
}

export class FreeProbeGate {
  private lastBurst = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxAlternates: number;

  constructor(ttlMs = 5 * 60_000, maxAlternates = 2) {
    this.ttlMs = ttlMs;
    this.maxAlternates = maxAlternates;
  }

  candidates(failedKey: string, routes: NormalizedRoute[], now = Date.now()): NormalizedRoute[] {
    const last = this.lastBurst.get(failedKey);
    if (last !== undefined && now - last < this.ttlMs) return [];
    this.lastBurst.set(failedKey, now);
    return routes
      .filter((route) => route.free && route.key !== failedKey && route.health.state !== 'COOLDOWN')
      .slice(0, this.maxAlternates);
  }
}

export function normalizeRuntimeSelector(selector: string): string {
  return selector.replace(/:(auto|low|medium|high|max|xhigh)$/i, '');
}

export interface RetryRoutingDecision {
  markRouteCooldown: boolean;
  nativeOwnsContinuation: boolean;
}

export function retryRoutingPolicy(
  rateOrQuota: boolean,
  delayMs: number | undefined,
  nativeFallbackApplied: boolean,
): RetryRoutingDecision {
  if (!rateOrQuota) {
    return { markRouteCooldown: false, nativeOwnsContinuation: true };
  }

  if (nativeFallbackApplied) {
    return { markRouteCooldown: true, nativeOwnsContinuation: true };
  }

  // OMP uses a zero-delay retry when it recovered inside the same provider,
  // e.g. by rotating to another credential or applying a banked reset. Do not
  // blacklist the whole provider/model route in that case.
  if (delayMs === 0) {
    return { markRouteCooldown: false, nativeOwnsContinuation: true };
  }

  // A quota/rate-limit retry that is actually waiting still belongs to OMP for
  // the current turn. Mark the route unavailable for future work; OMP's native
  // retry/fallback chain owns the in-flight continuation.
  return { markRouteCooldown: true, nativeOwnsContinuation: true };
}

export function shouldRouteBeforeAgentStart(retryActive: boolean): boolean {
  return !retryActive;
}
