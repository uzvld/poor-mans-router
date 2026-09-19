import type { NormalizedRoute, PriceVector } from './types.ts';
import type { OmpCredentialUsage, CodexBarUsage } from './telemetry.ts';
import type { LocalRouteState } from './health.ts';
import type { HistoryMap } from './history.ts';
import type { IntelMap } from './openrouter-intel.ts';
import { canonicalModelSlug } from './openrouter-intel.ts';
import { classifyModelId, decorateClasses } from './policy.ts';
import { evaluateRouteHealth } from './health.ts';

const MIX = { input: 1.0, output: 0.35, cacheRead: 4.0, cacheWrite: 0.05 };

export function effectiveCost(route: Pick<NormalizedRoute, 'free' | 'subscriptionLike' | 'price'>): number {
  if (route.free || route.subscriptionLike) return 0;
  const p = route.price;
  if (typeof p.input !== 'number' || typeof p.output !== 'number') return Number.POSITIVE_INFINITY;
  return (
    MIX.input * p.input +
    MIX.output * p.output +
    MIX.cacheRead * (p.cacheRead ?? 0) +
    MIX.cacheWrite * (p.cacheWrite ?? 0)
  );
}

/**
 * Parse a model id into a comparable generation vector, e.g.
 *   claude-3-5-sonnet-20240620 -> [3, 5]
 *   claude-sonnet-4-5-20250929 -> [4, 5]
 *   claude-sonnet-5            -> [5]
 * Dated snapshots (8-digit) and provider/vendor prefixes are ignored so that the
 * same generation ties regardless of release date. Returns [] when no generation
 * can be read, which sorts after any parsed generation.
 */
export function modelGeneration(modelId: string): number[] {
  const tail = modelId.toLowerCase().replace(/^~/, '').split('/').pop() ?? '';
  const parts = tail.split(/[-_.]/);
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) continue;
    if (part.length >= 8) continue; // release date snapshot, not a generation
    out.push(Number(part));
  }
  return out;
}

/** Family stem: the id with generation numbers, dates and variant suffixes removed. */
export function modelFamily(modelId: string): string {
  const tail = modelId.toLowerCase().replace(/^~/, '').split('/').pop() ?? '';
  return tail
    .replace(/:(free|discounted|batch|extended|auto|low|medium|high|max|xhigh)$/i, '')
    .split(/[-_.]/)
    .filter((part) => part && !/^\d+$/.test(part))
    .join('-');
}

/**
 * Newer generation first; equal generations tie (0). Generation numbers only mean
 * something within one family, so ids from different families always tie here and
 * fall through to the caller's next tie-break.
 */
export function compareModelGeneration(a: string, b: string): number {
  if (modelFamily(a) !== modelFamily(b)) return 0;
  const ga = modelGeneration(a);
  const gb = modelGeneration(b);
  const n = Math.max(ga.length, gb.length);
  for (let i = 0; i < n; i++) {
    const x = ga[i] ?? -1;
    const y = gb[i] ?? -1;
    if (x !== y) return y - x;
  }
  return 0;
}

function bestComparator(a: NormalizedRoute, b: NormalizedRoute, currentKey?: string): number {
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
  if (a.reliabilityScore !== b.reliabilityScore) return b.reliabilityScore - a.reliabilityScore;
  const aLatency = a.latencyMs ?? Number.POSITIVE_INFINITY;
  const bLatency = b.latencyMs ?? Number.POSITIVE_INFINITY;
  if (aLatency !== bLatency) return aLatency - bLatency;
  const aCost = effectiveCost(a);
  const bCost = effectiveCost(b);
  if (aCost !== bCost) return aCost - bCost;
  // Scoped bootstrap/current-model affinity: only once everything above ties, and only
  // between versions of the SAME family, keep the model the session is already on.
  // Never lets a bootstrap marker override economics, intel, or a different family.
  if (currentKey && modelFamily(a.modelId) === modelFamily(b.modelId)) {
    if (a.key === currentKey) return -1;
    if (b.key === currentKey) return 1;
  }
  // Quality-safe deterministic tie-break: newer model generation before any lexical order,
  // so an old dated Sonnet 3.5 cannot beat Sonnet 5 just because "3" sorts before "s".
  const gen = compareModelGeneration(a.modelId, b.modelId);
  if (gen !== 0) return gen;
  return a.key.localeCompare(b.key);
}

// Free-quota routes are metered by request count, not tokens or dollars: a model that
// finishes agentic tasks in fewer turns is worth more than one that is merely popular.
// Leads on the raw agentic-completion benchmark, then defers to the exact same
// reliability/latency/cost/affinity/generation/lexical chain as bestComparator.
function valueComparator(a: NormalizedRoute, b: NormalizedRoute, currentKey?: string): number {
  if (a.agenticScore !== b.agenticScore) return b.agenticScore - a.agenticScore;
  return bestComparator(a, b, currentKey);
}


export type RoutePreference = 'quality' | 'speed' | 'value';

function speedComparator(a: NormalizedRoute, b: NormalizedRoute): number {
  const aHasLatency = typeof a.latencyMs === 'number' && Number.isFinite(a.latencyMs);
  const bHasLatency = typeof b.latencyMs === 'number' && Number.isFinite(b.latencyMs);
  if (aHasLatency !== bHasLatency) return aHasLatency ? -1 : 1;
  if (aHasLatency && bHasLatency && a.latencyMs !== b.latencyMs) return (a.latencyMs as number) - (b.latencyMs as number);

  const aHasThroughput = typeof a.throughput === 'number' && Number.isFinite(a.throughput);
  const bHasThroughput = typeof b.throughput === 'number' && Number.isFinite(b.throughput);
  if (aHasThroughput !== bHasThroughput) return aHasThroughput ? -1 : 1;
  if (aHasThroughput && bHasThroughput && a.throughput !== b.throughput) return (b.throughput as number) - (a.throughput as number);

  const costDelta = effectiveCost(a) - effectiveCost(b);
  if (Number.isFinite(costDelta) && costDelta !== 0) return costDelta;
  if (a.reliabilityScore !== b.reliabilityScore) return b.reliabilityScore - a.reliabilityScore;
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
  return a.key.localeCompare(b.key);
}

function preferenceComparator(preference: RoutePreference, currentKey?: string) {
  if (preference === 'speed') return speedComparator;
  if (preference === 'value') return (a: NormalizedRoute, b: NormalizedRoute) => valueComparator(a, b, currentKey);
  return (a: NormalizedRoute, b: NormalizedRoute) => bestComparator(a, b, currentKey);
}

function cheapestThenBest(routes: NormalizedRoute[], currentKey?: string): NormalizedRoute | undefined {
  if (!routes.length) return undefined;
  const withKnownCost = routes.filter((r) => Number.isFinite(effectiveCost(r)));
  if (!withKnownCost.length) return [...routes].sort((a, b) => bestComparator(a, b, currentKey))[0];
  return [...withKnownCost].sort((a, b) => {
    const costDelta = effectiveCost(a) - effectiveCost(b);
    return costDelta !== 0 ? costDelta : bestComparator(a, b, currentKey);
  })[0];
}

function bestModelThenCheapestSeller(
  routes: NormalizedRoute[],
  preference: RoutePreference = 'quality',
  currentKey?: string,
): NormalizedRoute | undefined {
  if (!routes.length) return undefined;
  const byModel = new Map<string, NormalizedRoute[]>();
  for (const route of routes) {
    const slug = canonicalModelSlug(route.provider, route.modelId);
    const group = byModel.get(slug) ?? [];
    group.push(route);
    byModel.set(slug, group);
  }

  const representatives = [...byModel.values()]
    .map((sellerRoutes) => cheapestThenBest(sellerRoutes, currentKey))
    .filter((route): route is NormalizedRoute => !!route);
  return representatives.sort(preferenceComparator(preference, currentKey))[0];
}

export function selectWithinClass(
  routes: NormalizedRoute[],
  preference: RoutePreference = 'quality',
): NormalizedRoute | undefined {
  const healthy = routes.filter((r) => r.health.state === 'AVAILABLE');
  if (healthy.length) return bestModelThenCheapestSeller(healthy, preference);

  const available = routes.filter((r) => r.health.state !== 'COOLDOWN');
  if (!available.length) return undefined;
  return bestModelThenCheapestSeller(available, preference);
}

export interface SelectionResult {
  route: NormalizedRoute;
  className: string;
  reason: string;
}

export function selectForTier(
  routes: NormalizedRoute[],
  classOrder: string[],
  options: { allowDraining?: boolean; preference?: RoutePreference; currentKey?: string } = {},
): SelectionResult | undefined {
  const build = (route: NormalizedRoute, className: string): SelectionResult => {
    const cost = effectiveCost(route);
    const pricePart = Number.isFinite(cost) ? `effective-cost=${cost.toFixed(4)}` : 'price=unknown';
    return { route, className, reason: `${route.health.state.toLowerCase()} ${className}; ${pricePart}` };
  };

  // First exhaust the ordered class ladder using only healthy routes. This avoids
  // burning a draining preferred class when a healthy fallback class exists.
  for (const className of classOrder) {
    const healthy = routes.filter((r) => r.classes.includes(className) && r.health.state === 'AVAILABLE');
    const route = bestModelThenCheapestSeller(healthy, options.preference ?? 'quality', options.currentKey);
    if (route) return build(route, className);
  }

  if (options.allowDraining === false) return undefined;

  // Only after no healthy route exists anywhere in the tier do we admit degraded routes.
  for (const className of classOrder) {
    const degraded = routes.filter((r) => r.classes.includes(className) && r.health.state !== 'COOLDOWN');
    const route = bestModelThenCheapestSeller(degraded, options.preference ?? 'quality', options.currentKey);
    if (route) return build(route, className);
  }
  return undefined;
}

export interface OmpModelLike {
  provider: string;
  id: string;
  selector?: string;
  name?: string;
  cost?: PriceVector;
}

export interface BuildRoutesInputs {
  ompReports: OmpCredentialUsage[];
  codexbar: CodexBarUsage[];
  localState: Record<string, LocalRouteState | undefined>;
  history: HistoryMap;
  intel: IntelMap;
  reservePct: number;
  now: number;
}

function freeFromSelector(selector: string): boolean {
  const s = selector.toLowerCase();
  return s.endsWith(':free') || s.includes('/free') || s.includes('auto-free');
}

// Reliability of a route with no history is UNKNOWN, not good. The prior must sit
// at/below any plausible measured value so an untested sibling can never outrank a
// route we have actually exercised merely because it has no failures on record.
const UNMEASURED_RELIABILITY = 0.5;

function smoothedReliability(history: HistoryMap[string] | undefined): number {
  if (!history || history.requests <= 0) return UNMEASURED_RELIABILITY;
  const weight = Math.min(1, Math.max(0, history.requests / 20));
  const smoothed = weight * history.reliability + (1 - weight) * UNMEASURED_RELIABILITY;
  // Smoothing pulls toward the prior; a measured route is never worth less than unmeasured.
  return Math.max(smoothed, UNMEASURED_RELIABILITY);
}

function qualityFromIntel(intel: IntelMap[string] | undefined, reliability: number): number {
  const coding = intel?.coding ?? 0.5;
  const agentic = intel?.agentic ?? 0.5;
  const taskFit = intel?.taskFit ?? 0.5;
  const popularity = intel?.popularity ?? 0.5;
  // Tier/class fit is enforced structurally by class order. Public traffic popularity is
  // deliberately weak: it only nudges otherwise comparable candidates inside a class.
  return 0.35 + 0.24 * coding + 0.14 * agentic + 0.10 * taskFit + 0.10 * reliability + 0.07 * popularity;
}

export function buildRoutes(models: OmpModelLike[], input: BuildRoutesInputs): NormalizedRoute[] {
  const subscriptionProviders = new Set(input.ompReports.map((r) => r.provider));

  return models.filter((model) => !/:batch$/i.test(model.selector ?? model.id)).map((model) => {
    const selector = model.selector ?? `${model.provider}/${model.id}`;
    const key = `${model.provider}/${model.id}`;
    const free = freeFromSelector(selector) || classifyModelId(selector).includes('free');
    const subscriptionLike = !free && subscriptionProviders.has(model.provider);
    const baseClasses = classifyModelId(selector);
    const classes = decorateClasses(baseClasses, { free, subscriptionLike });
    const local = input.localState[key];
    const health = evaluateRouteHealth(
      { provider: model.provider, modelId: model.id, free },
      {
        ompReports: input.ompReports,
        codexbar: input.codexbar,
        local,
        reservePct: input.reservePct,
        now: input.now,
      },
    );

    const history = input.history[key];
    const reliabilityScore = smoothedReliability(history);
    const slug = canonicalModelSlug(model.provider, model.id);
    const intel = input.intel[slug];

    return {
      key,
      provider: model.provider,
      modelId: model.id,
      selector,
      name: model.name,
      classes,
      free,
      subscriptionLike,
      price: model.cost ?? {},
      health,
      qualityScore: qualityFromIntel(intel, reliabilityScore),
      agenticScore: intel?.agentic ?? 0.5,
      reliabilityScore,
      latencyMs: history?.ttftMs,
      throughput: history?.throughput,
    };
  });
}
