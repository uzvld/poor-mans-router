import type { NormalizedRoute, PriceVector } from './types.ts';
import type { OmpCredentialUsage, CodexBarUsage } from './telemetry.ts';
import type { LocalRouteState } from './health.ts';
import type { HistoryMap } from './history.ts';
import type { IntelMap } from './openrouter-intel.ts';
import { buildIntelLookup, canonicalModelSlug, intelMatchForRoute, type IntelMatch } from './openrouter-intel.ts';
import { classifyModelId, decorateClasses } from './policy.ts';
import { benchmarkPower } from './rungs.ts';
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

/**
 * Quality descending. An exact tie goes to the route that has a published benchmark index over one
 * that has none (I7): two routes the snapshot cannot tell apart on score are not equally known.
 */
function qualityOrder(a: NormalizedRoute, b: NormalizedRoute): number {
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
  const aKnown = a.benchmarked === true;
  const bKnown = b.benchmarked === true;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return 0;
}

function bestComparator(a: NormalizedRoute, b: NormalizedRoute, currentKey?: string): number {
  const quality = qualityOrder(a, b);
  if (quality !== 0) return quality;
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
  const quality = qualityOrder(a, b);
  if (quality !== 0) return quality;
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

// --- Intelligence-only models -------------------------------------------------------------------
// Artificial Analysis publishes only the overall Intelligence Index for a brand-new model; coding
// and agentic follow later (live 2026-10-11: sonnet-5.5, opus-5.5, gpt-6.1-sol). Scoring such a
// model with the neutral 0.5 priors ranks it below its own predecessor, but the intelligence scale
// sits far below the coding scale, so it cannot be compared with measured routes directly either.
// It is therefore placed on the coding scale by a measured model of the same lineage (vendor and
// model family): the reference's benchmark quality, moved by the intelligence gap. Between two such
// routes the index decides within a vendor (`orderByIntelligence`). Only these routes' scores change, so
// no pair of measured routes is re-ordered, and the scores are fixed by the catalog, the snapshot and the
// reliability history: they do not depend on which routes are in a candidate set or healthy. A route with
// no measured lineage keeps the neutral priors; `qualityOrder` still ranks it above one with no index at all.

/** Quality per point of intelligence index: the weight the formula gives coding plus agentic. */
const INTELLIGENCE_WEIGHT = 0.24 + 0.14;

/**
 * Most quality the intelligence gap may add over the reference. Across the 43 measured same-lineage
 * successor pairs in the 2026-10-11 snapshot the benchmark quality rose by a median 0.033, a 75th
 * percentile 0.056 and a 90th percentile 0.098; 0.10 credits any step that size and treats a larger
 * index gap as extrapolation, so a model cannot leap over measured routes of other lineages because
 * its reference sits far below it on the index. A judgment constant, pinned by the cap test.
 */
const MAX_INTELLIGENCE_CREDIT = 0.10;

interface IntelReference {
  key: string;
  intelligence: number;
  /** Benchmark quality of the reference without its reliability term. */
  quality: number;
}

function vendorOf(snapshotKey: string): string {
  return snapshotKey.toLowerCase().split('/')[0] ?? '';
}

function lineageOf(snapshotKey: string): string {
  return `${vendorOf(snapshotKey)}|${modelFamily(snapshotKey.toLowerCase())}`;
}

/** Measured models (coding and intelligence both published) grouped by lineage. */
function buildReferencePools(intel: IntelMap): Map<string, IntelReference[]> {
  const pools = new Map<string, IntelReference[]>();
  for (const [key, value] of Object.entries(intel)) {
    if (value.coding === undefined || value.intelligence === undefined) continue;
    const lineage = lineageOf(key);
    const pool = pools.get(lineage) ?? [];
    pool.push({ key, intelligence: value.intelligence, quality: qualityFromIntel(value, 0) });
    pools.set(lineage, pool);
  }
  return pools;
}

interface AnchoredBase {
  vendor: string;
  intelligence: number;
  /** Anchored quality before the route's own reliability term. */
  base: number;
  /** Most the vendor ordering may lift `base` to: the reference's quality plus the credit cap. */
  ceiling: number;
}

/**
 * Quality of an intelligence-only model, anchored on the same-lineage reference closest to it in
 * intelligence (least extrapolation; ties by key so the order never depends on iteration order).
 * The lineage is read from the snapshot key the route matched (`match.key`), the key the reference
 * pool is built from, not from the catalog slug: a bare id on a provider the slug helper does not
 * map (`opencode-go/grok-4.7`) is `opencode-go/...` there but `x-ai/grok-4.7` in the snapshot.
 * undefined when the model is coding-measured, has no intelligence index, or has no measured lineage.
 * taskFit and popularity are the reference's: a lone taskFit of 0.024 against the neutral 0.5 prior
 * outweighed a real intelligence lead (opus-5.5 at 57.6 lost to opus-5 at 50.8).
 */
function anchoredBase(match: IntelMatch | undefined, pools: Map<string, IntelReference[]>): AnchoredBase | undefined {
  if (!match || match.intel.coding !== undefined || match.intel.intelligence === undefined) return undefined;
  const pool = pools.get(lineageOf(match.key));
  if (!pool) return undefined;
  let reference: IntelReference | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const distance = Math.abs(candidate.intelligence - match.intel.intelligence);
    if (distance < gap || (distance === gap && reference !== undefined && candidate.key < reference.key)) {
      reference = candidate;
      gap = distance;
    }
  }
  if (!reference) return undefined;
  const credit = Math.min(
    MAX_INTELLIGENCE_CREDIT,
    INTELLIGENCE_WEIGHT * (match.intel.intelligence - reference.intelligence),
  );
  return {
    vendor: vendorOf(match.key),
    intelligence: match.intel.intelligence,
    base: reference.quality + credit,
    ceiling: reference.quality + MAX_INTELLIGENCE_CREDIT,
  };
}

/** An anchored route's score with its own reliability term added, and the most the ordering may lift it to. */
interface ScoredAnchor {
  vendor: string;
  intelligence: number;
  score: number;
  ceiling: number;
}

/** Smallest rise between two distinct index values within a vendor; far below any real score gap. */
const ENVELOPE_STEP = 1e-6;

/**
 * Final scores of the anchored routes, made strictly increasing in the intelligence index within each
 * vendor. Two lineages of one vendor can anchor so that the model the index rates lower gets the
 * higher estimate (a weak predecessor caps one successor's credit, a strong one lifts another):
 * opus-5.5 at 57.6 against sonnet-5.5 at 56.0 differ by 0.008 only because sonnet-5's coding sits far
 * above its index. A route is raised to one step above the highest score of the vendor's routes with a
 * lower index. It is applied to the scores with reliability already added, so a reliability gap cannot
 * turn the order back (opus-5.5 at 0.995 against sonnet-5.5 at 1.0). The raise stops at the route's
 * `ceiling`, reference quality + MAX_INTELLIGENCE_CREDIT: where the estimates disagree by more than
 * the credit cap the index no longer decides, the same limit that stops a large index gap from
 * carrying a route over measured routes (mistral-medium-3 was lifted by 0.131 onto another lineage's
 * anchor). Scoped to the vendor because nothing ties one vendor's index scale to another's: lifting
 * across vendors dragged deepseek-v4.1-flash above glm-5.3-flash on gpt-6-luna's estimate (measured on
 * the 2026-10-11 snapshot). Returns one entry per input, undefined where the route is not anchored; it
 * depends on the catalog, the snapshot and the reliability history, never on health.
 */
function orderByIntelligence(anchors: (ScoredAnchor | undefined)[]): (number | undefined)[] {
  const byVendor = new Map<string, number[]>();
  anchors.forEach((anchor, i) => {
    if (anchor) byVendor.set(anchor.vendor, [...(byVendor.get(anchor.vendor) ?? []), i]);
  });
  const ordered = anchors.map((anchor) => anchor?.score);
  for (const members of byVendor.values()) {
    const byIndex = new Map<number, number[]>();
    for (const i of members) {
      const intelligence = (anchors[i] as ScoredAnchor).intelligence;
      byIndex.set(intelligence, [...(byIndex.get(intelligence) ?? []), i]);
    }
    let reached = Number.NEGATIVE_INFINITY;
    for (const [, group] of [...byIndex].sort(([a], [b]) => a - b)) {
      const floor = reached + ENVELOPE_STEP;
      for (const i of group) {
        const anchor = anchors[i] as ScoredAnchor;
        const lifted = Math.max(anchor.score, Math.min(floor, anchor.ceiling));
        ordered[i] = lifted;
        reached = Math.max(reached, lifted);
      }
    }
  }
  return ordered;
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
  // One index per call: the snapshot is shared by every route, and resolving per route would repeat
  // the alias expansion 1200 times for no reason.
  const intelLookup = buildIntelLookup(input.intel);
  const referencePools = buildReferencePools(input.intel);

  const catalog = models.filter((model) => !/:batch$/i.test(model.selector ?? model.id));
  const catalogMatches = catalog.map((model) => intelMatchForRoute(intelLookup, model.provider, model.id));
  const catalogReliability = catalog.map((model) => smoothedReliability(input.history[`${model.provider}/${model.id}`]));
  const anchoredScores = orderByIntelligence(
    catalogMatches.map((match, i) => {
      const anchor = anchoredBase(match, referencePools);
      const own = 0.10 * (catalogReliability[i] as number);
      return anchor && { ...anchor, score: anchor.base + own, ceiling: anchor.ceiling + own };
    }),
  );

  return catalog.map((model, index) => {
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
    const reliabilityScore = catalogReliability[index] as number;
    const intel = catalogMatches[index]?.intel;
    const anchoredScore = anchoredScores[index];

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
      // Only a route scored from a measured lineage leaves the coding/agentic formula.
      qualityScore: anchoredScore ?? qualityFromIntel(intel, reliabilityScore),
      benchmarked: intel?.coding !== undefined || intel?.agentic !== undefined || intel?.intelligence !== undefined,
      agenticScore: intel?.agentic ?? 0.5,
      benchmarkPower: benchmarkPower(intel),
      reliabilityScore,
      latencyMs: history?.ttftMs,
      throughput: history?.throughput,
    };
  });
}
