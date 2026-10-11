import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, selectForTier } from '../ranking.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import type { NormalizedRoute } from '../types.ts';

// Follow-ups to the intelligence-only anchor (docs/investigations/finding-intelligence-only-benchmarks.md,
// "Follow-ups"): the lineage vendor comes from the snapshot key that matched, the index order holds
// over reliability, the lift of that order is bounded, and the equidistant-reference tie is pinned.
// Fixture arithmetic (neutral taskFit/popularity/agentic 0.5, route reliability 0.5 unless a history is given):
//   quality(coding c, reliability r) = 0.505 + 0.24c + 0.10r   (0.35 + 0.07 + 0.05 + 0.035 + 0.24c + 0.10r)
// An anchored route scores that of its reference at r = 0, plus min(0.10, 0.38 x index gap), plus 0.10 x r.

const NOW = Date.parse('2026-09-19T02:56:09.916Z');
const CLEAN = { reliability: 1, errorRate: 0, requests: 20 };
const PRECISION = 1e-9;

type Spec = readonly [provider: string, id: string];

function build(intel: IntelMap, specs: Spec[], history: Record<string, typeof CLEAN> = {}): NormalizedRoute[] {
  return buildRoutes(
    specs.map(([provider, id]) => ({ provider, id, selector: `${provider}/${id}`, cost: { input: 2, output: 10 } })),
    { ompReports: [], codexbar: [], localState: {}, history, intel, reservePct: 10, now: NOW },
  );
}

function scoreOf(routes: NormalizedRoute[], key: string): number {
  const route = routes.find((r) => r.key === key);
  assert.ok(route, `${key} is in the catalog`);
  return route.qualityScore;
}

function assertScore(actual: number, expected: number, message: string) {
  assert.ok(Math.abs(actual - expected) < PRECISION, `${message}: expected ${expected}, got ${actual}`);
}

const winnerOf = (routes: NormalizedRoute[], keys: string[]) =>
  selectForTier(routes.filter((r) => keys.includes(r.key)), ['best-available'], { allowDraining: true, preference: 'quality' })
    ?.route.key;

// --- 1. The lineage vendor is the snapshot key's vendor, not the catalog slug's ---------------------

const BARE_IDS: { label: string; intel: IntelMap; bare: Spec; prefixed: Spec; expected: number }[] = [
  {
    label: 'opencode-go/mimo-v2.6-flash',
    intel: {
      'xiaomi/mimo-v2-flash': { coding: 0.6, agentic: 0.5, intelligence: 0.3 },
      'xiaomi/mimo-v2.6-flash': { intelligence: 0.45 },
    },
    bare: ['opencode-go', 'mimo-v2.6-flash'],
    prefixed: ['openrouter', 'xiaomi/mimo-v2.6-flash'],
    expected: 0.505 + 0.24 * 0.6 + 0.38 * 0.15 + 0.05,
  },
  {
    label: 'opencode-go/grok-4.7',
    intel: {
      'x-ai/grok-4.6': { coding: 0.7, agentic: 0.5, intelligence: 0.4 },
      'x-ai/grok-4.7': { intelligence: 0.46 },
    },
    bare: ['opencode-go', 'grok-4.7'],
    prefixed: ['openrouter', 'x-ai/grok-4.7'],
    expected: 0.505 + 0.24 * 0.7 + 0.38 * 0.06 + 0.05,
  },
  {
    label: 'opencode-go/minimax-m2.5',
    intel: {
      'minimax/minimax-m2.7': { coding: 0.65, agentic: 0.5, intelligence: 0.3 },
      'minimax/minimax-m2.5': { intelligence: 0.25 },
    },
    bare: ['opencode-go', 'minimax-m2.5'],
    prefixed: ['openrouter', 'minimax/minimax-m2.5'],
    expected: 0.505 + 0.24 * 0.65 + 0.38 * -0.05 + 0.05,
  },
];

for (const { label, intel, bare, prefixed, expected } of BARE_IDS) {
  test(`${label}: a bare id on a provider the slug helper does not map is anchored like its prefixed twin`, () => {
    const routes = build(intel, [bare, prefixed]);
    const bareKey = `${bare[0]}/${bare[1]}`;
    const prefixedKey = `${prefixed[0]}/${prefixed[1]}`;
    assertScore(scoreOf(routes, prefixedKey), expected, 'the prefixed route');
    assertScore(scoreOf(routes, bareKey), expected, 'the same model through another seller');
  });
}

test('a bare-id route is ordered against its vendor by the snapshot vendor, not the catalog provider', () => {
  // gamma-2 (index 0.44) arrives as a bare id on opencode-go: anchored 0.649 + 0.38 x 0.04 = 0.6642.
  // zeta-2 (index 0.45, the prefixed seller) anchors on a weaker reference: 0.601 + 0.0076 = 0.6086,
  // below the neutral 0.625 a route with no reference scores. They share a vendor only through the
  // snapshot key, so only an anchored gamma-2 puts zeta-2 on the vendor's index order, one step above it.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.44 },
    'acme/zeta-1': { coding: 0.4, agentic: 0.5, intelligence: 0.43 },
    'acme/zeta-2': { intelligence: 0.45 },
  };
  const routes = build(intel, [['opencode-go', 'gamma-2'], ['openrouter', 'acme/zeta-2']]);
  assertScore(scoreOf(routes, 'opencode-go/gamma-2'), 0.505 + 0.24 * 0.6 + 0.38 * 0.04 + 0.05, 'the bare-id route');
  assertScore(
    scoreOf(routes, 'openrouter/acme/zeta-2'),
    scoreOf(routes, 'opencode-go/gamma-2') + 1e-6,
    'the higher index, one step above the lower one of the same vendor',
  );
});

// --- 2. The index order survives the reliability term ----------------------------------------------

test('a reliability gap does not let the lower-index route of one vendor outrank the higher-index one', () => {
  // gamma-2 (index 0.45) anchors on a strong reference: 0.649 + 0.019 = 0.668. zeta-2 (index 0.50)
  // anchors lower: 0.6226 + 0.38 x 0.11 = 0.6644. The index says zeta-2; gamma-2 has 20 clean requests
  // (reliability 1.0, +0.05 over zeta-2's unmeasured 0.5), which used to outweigh the 1e-6 ordering step.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
    'acme/zeta-1': { coding: 0.49, agentic: 0.5, intelligence: 0.39 },
    'acme/zeta-2': { intelligence: 0.5 },
  };
  const ids: Spec[] = [['openrouter', 'acme/gamma-2'], ['openrouter', 'acme/zeta-2']];
  const keys = ids.map(([provider, id]) => `${provider}/${id}`);
  const proven = build(intel, ids, { 'openrouter/acme/gamma-2': CLEAN });
  assert.equal(winnerOf(proven, keys), 'openrouter/acme/zeta-2');
  const reversed = build(intel, [...ids].reverse(), { 'openrouter/acme/gamma-2': CLEAN });
  assert.equal(winnerOf(reversed, keys), 'openrouter/acme/zeta-2');
});

test('a 0.005 reliability gap does not flip two vendor routes one index step apart (opus-5.5 against sonnet-5.5)', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5': { coding: 0.715, agentic: 0.436, intelligence: 0.382, taskFit: 0.051, popularity: 0.876 },
    'anthropic/claude-sonnet-5.5': { intelligence: 0.56 },
    // Reference qualities 0.649 (sonnet-5) and 0.683 (opus-5): the successors anchor at 0.717 and 0.709,
    // and the index puts opus-5.5 above sonnet-5.5, as on the live snapshot.
    'anthropic/claude-opus-5': { coding: 0.91, agentic: 0.5, intelligence: 0.508, taskFit: 0.024, popularity: 0.6 },
    'anthropic/claude-opus-5.5': { intelligence: 0.576 },
  };
  const ids: Spec[] = [['anthropic', 'claude-opus-5-5'], ['anthropic', 'claude-sonnet-5-5']];
  const keys = ids.map(([provider, id]) => `${provider}/${id}`);
  const equal = { 'anthropic/claude-opus-5-5': CLEAN, 'anthropic/claude-sonnet-5-5': CLEAN };
  assert.equal(winnerOf(build(intel, ids, equal), keys), 'anthropic/claude-opus-5-5');
  // 200 requests, 1 error: reliability 0.995, 0.0005 of score below the other's 1.0, 500 times the step.
  const slightlyWorse = { ...equal, 'anthropic/claude-opus-5-5': { reliability: 0.995, errorRate: 0.005, requests: 200 } };
  assert.equal(winnerOf(build(intel, ids, slightlyWorse), keys), 'anthropic/claude-opus-5-5');
});

// --- 3. The order never lifts a route more than the credit cap above its own reference ---------------

test('the order between lineages lifts a route at most 0.10 above its reference, however far the other estimate sits', () => {
  // medium-2 (index 0.09) anchors on medium-1 (coding 0.1): 0.529. large-2 (index 0.08) anchors on
  // large-1 (coding 0.8): 0.697. Unbounded, the order lifts medium-2 by 0.168 to 0.697 and it outranks
  // other/m (coding 0.7, 0.673) which no intelligence index puts below it. Bounded to reference +
  // MAX_INTELLIGENCE_CREDIT it stays at 0.629 + reliability 0.05.
  const intel: IntelMap = {
    'acme/medium-1': { coding: 0.1, agentic: 0.5, intelligence: 0.09 },
    'acme/medium-2': { intelligence: 0.09 },
    'acme/large-1': { coding: 0.8, agentic: 0.5, intelligence: 0.08 },
    'acme/large-2': { intelligence: 0.08 },
    'other/m-1': { coding: 0.7, agentic: 0.5, intelligence: 0.5 },
  };
  const routes = build(intel, [
    ['openrouter', 'acme/medium-2'],
    ['openrouter', 'acme/large-2'],
    ['openrouter', 'other/m-1'],
  ]);
  assertScore(scoreOf(routes, 'openrouter/acme/large-2'), 0.505 + 0.24 * 0.8 + 0.05, 'the unlifted large-2');
  assertScore(scoreOf(routes, 'openrouter/acme/medium-2'), 0.505 + 0.24 * 0.1 + 0.10 + 0.05, 'medium-2 at its ceiling');
  assert.equal(winnerOf(routes, ['openrouter/acme/medium-2', 'openrouter/other/m-1']), 'openrouter/other/m-1');
});

test('a lift inside the bound is applied in full: the order between lineages still holds', () => {
  // zeta-2's reference sits 0.03 under gamma-2's estimate; the cap leaves room for that.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
    'acme/zeta-1': { coding: 0.49, agentic: 0.5, intelligence: 0.39 },
    'acme/zeta-2': { intelligence: 0.5 },
  };
  const routes = build(intel, [['openrouter', 'acme/gamma-2'], ['openrouter', 'acme/zeta-2']]);
  const gamma = scoreOf(routes, 'openrouter/acme/gamma-2');
  assertScore(scoreOf(routes, 'openrouter/acme/zeta-2'), gamma + 1e-6, 'zeta-2 one step above gamma-2');
});

// --- 4. Two references equally far from the route: the smaller key is the reference ------------------

test('with two references equally far in intelligence the smaller key is the reference, whatever the snapshot order', () => {
  // tie-2 (0.5) is 0.25 from tie-1 (0.25) and from tie-3 (0.75), all exact in binary.
  // From tie-1: 0.505 + 0.192 + 0.38 x 0.25 + 0.05 = 0.842. From tie-3: 0.505 + 0.096 - 0.095 + 0.05 = 0.556.
  const rows = {
    tie1: { coding: 0.8, agentic: 0.5, intelligence: 0.25 },
    tie3: { coding: 0.4, agentic: 0.5, intelligence: 0.75 },
  };
  const orders: IntelMap[] = [
    { 'acme/tie-1': rows.tie1, 'acme/tie-3': rows.tie3, 'acme/tie-2': { intelligence: 0.5 } },
    { 'acme/tie-3': rows.tie3, 'acme/tie-1': rows.tie1, 'acme/tie-2': { intelligence: 0.5 } },
  ];
  for (const intel of orders) {
    const routes = build(intel, [['openrouter', 'acme/tie-2']]);
    assertScore(scoreOf(routes, 'openrouter/acme/tie-2'), 0.505 + 0.192 + 0.38 * 0.25 + 0.05, Object.keys(intel).join(' '));
  }
});
