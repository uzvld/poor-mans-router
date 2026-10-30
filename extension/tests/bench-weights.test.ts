import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoutes } from '../ranking.ts';
import { benchmarkPower, computeLadders } from '../rungs.ts';
import { DEFAULT_POLICY, DEFAULT_WEIGHTS, normalizePolicy } from '../policy.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import type { FacetWeights } from '../bench-types.ts';
import type { NormalizedRoute, Tier } from '../types.ts';

const near = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);

test('power is renormalised over the facets a model has, never padded with a prior (I7)', () => {
  const weights: FacetWeights = { coding: 0.5, agentic: 0.5, general: 1 };
  near(benchmarkPower({ coding: 0.8, agentic: 0.4 }, weights), 0.6);
  near(benchmarkPower({ general: 0.5 }, weights), 0.5);
  near(benchmarkPower({ coding: 0.9 }, weights), 0.9);
  assert.equal(benchmarkPower({}, weights), undefined);
  assert.equal(benchmarkPower({ popularity: 0.9, taskFit: 0.5 }, weights), undefined);
  assert.equal(benchmarkPower(undefined, weights), undefined);
});

test('benchmark power is the composite under the tier\u2019s weights', () => {
  const intel = { coding: 0.9, agentic: 0.3 };
  near(benchmarkPower(intel, DEFAULT_WEIGHTS.frontier), (0.9 * 0.4 + 0.3 * 0.45) / 0.85);
  near(benchmarkPower(intel, DEFAULT_WEIGHTS.small), (0.9 * 0.4 + 0.3 * 0.2) / 0.6);
});

// --- weights reach the ladders ---------------------------------------------------------------------

function classRoute(key: string, className: string, intel: IntelMap[string], weights: FacetWeights): NormalizedRoute {
  return {
    key,
    provider: 'p',
    modelId: key,
    selector: key,
    classes: [className],
    free: false,
    subscriptionLike: true,
    price: {},
    health: { state: 'AVAILABLE', freshness: 'FRESH' },
    qualityScore: 0.5,
    agenticScore: 0.5,
    benchmarkPower: benchmarkPower(intel, weights),
    reliabilityScore: 0.5,
  };
}

const POLICY = normalizePolicy({ tiers: Object.fromEntries((['frontier', 'balanced', 'small', 'free'] as const).map((t) => [t, { classes: ['a', 'b'] }])) });
// `a` is the stronger coder, `b` the stronger agent: agentic-heavy weights must put `b` first, coding-heavy ones keep `a`.
const A: IntelMap[string] = { coding: 0.9, agentic: 0.3 };
const B: IntelMap[string] = { coding: 0.5, agentic: 0.8 };
const perTier = Object.fromEntries((['frontier', 'balanced', 'small', 'free'] as const).map((tier) => [tier, [
  classRoute('ra', 'a', A, DEFAULT_WEIGHTS[tier]),
  classRoute('rb', 'b', B, DEFAULT_WEIGHTS[tier]),
]])) as Record<Tier, NormalizedRoute[]>;

test('each tier orders its rungs by its own weights', () => {
  const ladders = computeLadders(POLICY, perTier);
  assert.deepEqual(ladders.frontier.order, ['b', 'a'], 'frontier weights agentic work above coding');
  assert.deepEqual(ladders.small.order, ['a', 'b'], 'small weights coding above agentic work');
});

test('a single route list still works and serves every tier, as before', () => {
  const ladders = computeLadders(POLICY, perTier.small);
  for (const tier of ['frontier', 'balanced', 'small', 'free'] as const) assert.deepEqual(ladders[tier].order, ['a', 'b'], tier);
});

// --- weights reach the score inside a class --------------------------------------------------------

function qualityUnder(weights: FacetWeights): number {
  const [route] = buildRoutes([{ provider: 'anthropic', id: 'claude-sonnet-5' }], {
    ompReports: [],
    codexbar: [],
    localState: {},
    history: {},
    intel: { 'anthropic/claude-sonnet-5': { coding: 0.9, agentic: 0.3 } },
    reservePct: 10,
    now: 0,
    weights,
  });
  return (route as NormalizedRoute).qualityScore;
}

test('the same model scores differently under different tier weights, by the 0.38 benchmark budget', () => {
  const frontier = qualityUnder(DEFAULT_WEIGHTS.frontier);
  const small = qualityUnder(DEFAULT_WEIGHTS.small);
  near(small - frontier, 0.38 * ((0.9 * 0.4 + 0.3 * 0.2) / 0.6 - (0.9 * 0.4 + 0.3 * 0.45) / 0.85));
});

test('with no weights given the balanced ones are used', () => {
  const [route] = buildRoutes([{ provider: 'anthropic', id: 'claude-sonnet-5' }], {
    ompReports: [], codexbar: [], localState: {}, history: {}, reservePct: 10, now: 0,
    intel: { 'anthropic/claude-sonnet-5': { coding: 0.9, agentic: 0.3 } },
  });
  near(route?.qualityScore, qualityUnder(DEFAULT_WEIGHTS.balanced));
});

// --- policy ----------------------------------------------------------------------------------------

test('weights are read from policy, and a damaged entry falls back to the shipped one for that tier only', () => {
  const policy = normalizePolicy({
    weights: {
      frontier: { coding: 1, agentic: 0, general: 0 },
      small: { coding: -1, agentic: 1, general: 1 },
      balanced: { coding: 0, agentic: 0, general: 0 },
      free: { coding: 'x', agentic: 1, general: 1 },
    },
  });
  assert.deepEqual(policy.weights?.frontier, { coding: 1, agentic: 0, general: 0 });
  assert.deepEqual(policy.weights?.small, DEFAULT_WEIGHTS.small, 'a negative weight is refused');
  assert.deepEqual(policy.weights?.balanced, DEFAULT_WEIGHTS.balanced, 'weights that sum to nothing are refused');
  assert.deepEqual(policy.weights?.free, DEFAULT_WEIGHTS.free, 'a non-number is refused');
});

test('a policy with no weights block uses the shipped weights', () => {
  assert.deepEqual(normalizePolicy({}).weights, DEFAULT_WEIGHTS);
  assert.deepEqual(DEFAULT_POLICY.weights, DEFAULT_WEIGHTS);
});

test('the weights in the shipped policy.yml are the ones the code defaults to', () => {
  const text = readFileSync(new URL('../policy.yml', import.meta.url), 'utf8');
  assert.deepEqual(normalizePolicy(Bun.YAML.parse(text)).weights, DEFAULT_WEIGHTS);
  assert.match(text, /^weights:/m);
});

// `general` is the intelligence index put on the coding scale by the blend (bench-blend.ts). The raw index
// sits far below coding and agentic (0.2-0.5 against 0.4-0.8), so it is never mixed into the composite as it is.
test('general counts under the tier weights: a much stronger general score beats a slightly stronger coder', () => {
  const coder: IntelMap[string] = { coding: 0.8, agentic: 0.5, general: 0.3 };
  const thinker: IntelMap[string] = { coding: 0.7, agentic: 0.4, general: 0.9 };
  assert.ok((benchmarkPower(thinker, DEFAULT_WEIGHTS.balanced) ?? 0) > (benchmarkPower(coder, DEFAULT_WEIGHTS.balanced) ?? 1));
  const noGeneral: FacetWeights = { coding: 0.24, agentic: 0.14, general: 0 };
  assert.ok((benchmarkPower(coder, noGeneral) ?? 0) > (benchmarkPower(thinker, noGeneral) ?? 1), 'with no weight on general the coder wins, as before');
});

test('the raw intelligence index is not power: on its own scale it would drag every model that has one below one that has none', () => {
  assert.equal(benchmarkPower({ intelligence: 0.5 }, DEFAULT_WEIGHTS.balanced), undefined);
  assert.equal(benchmarkPower({ coding: 0.7, intelligence: 0.1 }, DEFAULT_WEIGHTS.balanced), 0.7);
});
