import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutes, selectForTier, type RoutePreference } from '../ranking.ts';
import { normalizeOmpUsage } from '../telemetry.ts';
import { EMPTY_INTEL_CACHE, fetchOpenRouterIntel, normalizeBenchmarkRows, type IntelMap } from '../openrouter-intel.ts';

// Live 2026-10-11: Artificial Analysis published only the overall Intelligence Index for the 5.5
// family (Sonnet 5.5 = 56.0, Opus 5.5 = 57.6); coding_index and agentic_index are still null, so the
// `coding`/`agentic` requests never return those rows. The router then scored the unmeasured 5.5
// with neutral 0.5 coding/agentic and ranked it below Sonnet 5 (intelligence 38.2, coding 71.5).
const LIVE_NOW = Date.parse('2026-09-19T02:56:09.916Z');

function routesFor(intel: IntelMap, ids: string[]) {
  return buildRoutes(
    ids.map((id) => ({ provider: 'anthropic', id, selector: `anthropic/${id}`, cost: { input: 2, output: 10 } })),
    {
      ompReports: normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/live-omp-usage-2026-09-19.json', 'utf8'))),
      codexbar: [], localState: {}, history: {}, intel, reservePct: 10, now: LIVE_NOW,
    },
  );
}

const winner = (intel: IntelMap, ids: string[], preference: RoutePreference = 'quality') =>
  selectForTier(routesFor(intel, ids), ['sonnet-sub'], { allowDraining: true, preference })?.route.modelId;

const SONNET_5 = { coding: 0.715, agentic: 0.436, intelligence: 0.382 };
const PAIR = ['claude-sonnet-5', 'claude-sonnet-5-5'];

test('the intelligence index is read from a benchmark row even when coding and agentic are null', () => {
  const intel = normalizeBenchmarkRows(
    { data: [{ model_permaslug: 'anthropic/claude-sonnet-5.5-20260928', intelligence_index: 56, coding_index: null, agentic_index: null }] },
    'intelligence',
  );
  assert.deepEqual(intel, { 'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 } });
});

test('a refresh stores the intelligence index the Data API returns for a model with no coding index', async () => {
  const payloads: Record<string, unknown> = {
    'task_type=coding': { data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260630', coding_index: 71.5 }] },
    'task_type=agentic': { data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260630', agentic_index: 43.6 }] },
    'task_type=intelligence': { data: [
      { model_permaslug: 'anthropic/claude-sonnet-5-20260630', intelligence_index: 38.2, coding_index: 71.5, agentic_index: 43.6 },
      { model_permaslug: 'anthropic/claude-sonnet-5.5-20260928', intelligence_index: 56, coding_index: null, agentic_index: null },
    ] },
    'classifications/task': { data: [] },
    'datasets/rankings-daily': { data: [] },
  };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(payloads)) {
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const cache = await fetchOpenRouterIntel('sk-or-test', { ...EMPTY_INTEL_CACHE }, LIVE_NOW);
    assert.equal(cache.data['anthropic/claude-sonnet-5.5-20260928']?.intelligence, 0.56);
    assert.equal(cache.data['anthropic/claude-sonnet-5.5-20260928']?.coding, undefined);
    assert.equal(cache.data['anthropic/claude-sonnet-5-20260630']?.coding, 0.715);
  } finally {
    globalThis.fetch = real;
  }
});

test('a model with only an intelligence index beats a predecessor with a lower one (live 2026-10-11)', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 },
  };
  assert.equal(winner(intel, PAIR), 'claude-sonnet-5-5');
});

test('a measured taskFit below the neutral prior does not cancel a real intelligence lead (opus-5.5, live 2026-10-11)', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.45, taskFit: 0.024 },
  };
  assert.equal(winner(intel, PAIR), 'claude-sonnet-5-5');
});

test('an intelligence-only model does not win when its index is lower than the measured sibling', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.3 },
  };
  assert.equal(winner(intel, PAIR), 'claude-sonnet-5');
});

test('when every candidate has coding, intelligence does not decide: coding still outranks it', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': { coding: 0.8, agentic: 0.5, intelligence: 0.3 },
    'anthropic/claude-sonnet-5.5-20260928': { coding: 0.7, agentic: 0.4, intelligence: 0.9 },
  };
  assert.equal(winner(intel, PAIR), 'claude-sonnet-5');
});

test('a candidate with no intelligence index cannot be compared on it, so existing scoring stands', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { popularity: 0.9 },
  };
  assert.equal(winner(intel, PAIR), 'claude-sonnet-5');
});

test('a newer model with no benchmark at all does not outrank a measured one (I7)', () => {
  // sonnet-5-5 has no row: it scores the neutral prior, below measured sonnet-5, and being the newest
  // must not rescue it through the generation tie-break.
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-4-5': { intelligence: 0.3 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5']), 'claude-sonnet-5');
});

test('a route with only an index beats an unmeasured newer one: the evidence tie-break, not generation, decides', () => {
  // sonnet-4-5 has an intelligence index but no measured lineage, so it keeps the neutral prior and
  // exactly ties unmeasured sonnet-5; the generation tie-break would then pick the newer model.
  const intel: IntelMap = { 'anthropic/claude-sonnet-4-5': { intelligence: 0.5 } };
  assert.equal(winner(intel, ['claude-sonnet-4-5', 'claude-sonnet-5']), 'claude-sonnet-4-5');
});

test('an intelligence-only successor wins under the value and speed preferences used by free and small', () => {
  // Equal agentic (0.5) so `value`, which leads on it, falls through to quality; speed has no latency
  // or cost difference on a subscription, so it also falls through to quality.
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': { coding: 0.715, agentic: 0.5, intelligence: 0.382 },
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 },
  };
  assert.equal(winner(intel, PAIR, 'value'), 'claude-sonnet-5-5');
  assert.equal(winner(intel, PAIR, 'speed'), 'claude-sonnet-5-5');
});

// --- Narrowed rule: an intelligence-only route is scored from its own lineage, never the whole set ---
//
// A route with no coding index but an intelligence index is placed on the coding scale by a measured
// reference of the same vendor and model family: reference quality + 0.38 x the intelligence gap, the
// credit capped at one typical generation step. Every other pair keeps its coding/agentic order.
// Fixture arithmetic (neutral taskFit/popularity, reliability 0.5 everywhere unless stated):
// base(coding c, agentic 0.5) = 0.435 + 0.24c + 0.07; the reliability term 0.10 x 0.5 is common.

const NOW_HEALTH = { reliability: 1, errorRate: 0, requests: 20 };

function genericRoutes(intel: IntelMap, ids: string[], history: Record<string, typeof NOW_HEALTH> = {}) {
  return buildRoutes(
    ids.map((id) => ({ provider: 'openrouter', id, selector: `openrouter/${id}`, cost: { input: 2, output: 10 } })),
    { ompReports: [], codexbar: [], localState: {}, history, intel, reservePct: 10, now: LIVE_NOW },
  );
}

const pick = (
  intel: IntelMap,
  ids: string[],
  preference: RoutePreference = 'quality',
  history: Record<string, typeof NOW_HEALTH> = {},
) => selectForTier(genericRoutes(intel, ids, history), ['best-available'], { allowDraining: true, preference })?.route.modelId;

// Two coding-measured routes whose intelligence indexes disagree with their coding order.
const A_VS_B: IntelMap = {
  'acme/alpha-2': { coding: 0.8, agentic: 0.5, intelligence: 0.3 },
  'acme/beta-2': { coding: 0.7, agentic: 0.5, intelligence: 0.9 },
};

test('a far-away intelligence-only route in the same class does not re-rank two coding-measured routes', () => {
  const intel: IntelMap = { ...A_VS_B, 'zeta/zeta-9': { intelligence: 0.95 } };
  const pair = ['acme/alpha-2', 'acme/beta-2'];
  assert.equal(pick(intel, pair), 'acme/alpha-2');
  assert.equal(pick(intel, [...pair, 'zeta/zeta-9']), 'acme/alpha-2');
});

test('marking an unrelated intelligence-only route DRAINING does not flip the winner between two other routes', () => {
  // zeta-9 is never the winner in either state, so its health must not matter to A vs B.
  const intel: IntelMap = { ...A_VS_B, 'zeta/zeta-9': { intelligence: 0.1 } };
  const routes = genericRoutes(intel, ['acme/alpha-2', 'acme/beta-2', 'zeta/zeta-9']);
  const draining = routes.map((r) =>
    r.modelId === 'zeta/zeta-9' ? { ...r, health: { ...r.health, state: 'DRAINING' as const } } : r);
  const options = { allowDraining: true, preference: 'quality' as const };
  assert.equal(selectForTier(routes, ['best-available'], options)?.route.modelId, 'acme/alpha-2');
  assert.equal(selectForTier(draining, ['best-available'], options)?.route.modelId, 'acme/alpha-2');
});

test('an intelligence-only successor outranks an unrelated measured route its reference was below', () => {
  // gamma-1 (base 0.649) sits just under delta-1 (0.6538); gamma-2 = 0.649 + 0.38 x 0.05 = 0.668.
  // delta-1 has a far higher intelligence index, which must not matter: it is measured on coding.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
    'other/delta-1': { coding: 0.62, agentic: 0.5, intelligence: 0.9 },
  };
  assert.equal(pick(intel, ['acme/gamma-1', 'acme/gamma-2', 'other/delta-1']), 'acme/gamma-2');
  assert.equal(pick(intel, ['acme/gamma-1', 'other/delta-1']), 'other/delta-1');
});

test('the intelligence credit is capped at 0.10: a huge index gap cannot leap over a measured route above the reference', () => {
  // gamma-1 base 0.601. Uncapped, gamma-2 would score 0.601 + 0.209 = 0.810; capped it is 0.701.
  // delta-1 (0.709) is above the capped score, m-3 (0.692) is below it.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.4, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.95 },
    'other/delta-1': { coding: 0.85, agentic: 0.5, intelligence: 0.9 },
    'other/m-3': { coding: 0.78, agentic: 0.5, intelligence: 0.9 },
  };
  assert.equal(pick(intel, ['acme/gamma-1', 'acme/gamma-2', 'other/delta-1']), 'other/delta-1');
  assert.equal(pick(intel, ['acme/gamma-1', 'acme/gamma-2', 'other/m-3']), 'acme/gamma-2');
  assert.equal(pick(intel, ['acme/gamma-1', 'acme/gamma-2']), 'acme/gamma-2');
});

test('the reference is the same-lineage measured model closest in intelligence', () => {
  // eps-3 (base 0.697, intel 0.50) is the nearest to eps-4 (0.52): 0.697 + 0.0076 beats zeta-1 (0.6922).
  // Anchored on the far eps-1 (base 0.577, credit capped at 0.10) it would score 0.677 and lose.
  const intel: IntelMap = {
    'acme/eps-1': { coding: 0.3, agentic: 0.5, intelligence: 0.2 },
    'acme/eps-3': { coding: 0.8, agentic: 0.5, intelligence: 0.5 },
    'acme/eps-4': { intelligence: 0.52 },
    'other/zeta-1': { coding: 0.78, agentic: 0.5, intelligence: 0.9 },
  };
  assert.equal(pick(intel, ['acme/eps-1', 'acme/eps-3', 'acme/eps-4', 'other/zeta-1']), 'acme/eps-4');
});

test('a measured model of another family is not a reference, even from the same vendor', () => {
  const intel: IntelMap = {
    'acme/omega-1': { coding: 0.9, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.95 },
  };
  assert.equal(pick(intel, ['acme/omega-1', 'acme/gamma-2']), 'acme/omega-1');
});

test('a measured model of the same family name from another vendor is not a reference', () => {
  const intel: IntelMap = {
    'acme/alpha-1': { coding: 0.9, agentic: 0.5, intelligence: 0.4 },
    'other/alpha-2': { intelligence: 0.95 },
  };
  assert.equal(pick(intel, ['acme/alpha-1', 'other/alpha-2']), 'acme/alpha-1');
});

test('the successor keeps its own reliability: an unproven route does not inherit its reference history', () => {
  // gamma-1 has 20 clean requests (0.749); gamma-2 has none: 0.649 + 0.019 + 0.05 = 0.718.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
  };
  const history = { 'openrouter/acme/gamma-1': NOW_HEALTH };
  assert.equal(pick(intel, ['acme/gamma-1', 'acme/gamma-2'], 'quality', history), 'acme/gamma-1');
});

test('with no measured reference a route that has an index still beats one that has none (I7)', () => {
  // Both score the neutral prior; alpha sorts first on the final key, so only the evidence tie-break
  // can hand the win to beta, and it must do so under every preference.
  const intel: IntelMap = { 'acme/beta': { intelligence: 0.3 } };
  for (const preference of ['quality', 'value', 'speed'] as const) {
    assert.equal(pick(intel, ['acme/alpha', 'acme/beta'], preference), 'acme/beta', preference);
  }
});

test('a coding-measured route keeps exactly the score the coding/agentic formula gives it', () => {
  // No other pair may be re-ordered, not even by a rounding step: the anchored path is for routes
  // without a coding index only.
  const rows = [
    { coding: 0.715, agentic: 0.436, intelligence: 0.382, taskFit: 0.051, popularity: 0.876 },
    { coding: 0.783, agentic: 0.502, intelligence: 0.47, taskFit: 0.127, popularity: 0.8977 },
    { coding: 0.6, agentic: 0.5, intelligence: 0.4, popularity: 0.3333 },
    { coding: 0.71, agentic: 0.29, intelligence: 0.1 },
    // Chosen so that adding the reliability term last instead of in formula order differs by one ulp.
    { coding: 0.408, agentic: 0.16, intelligence: 0.2, taskFit: 0.207, popularity: 0.235 },
    { coding: 0.487, agentic: 0.048, intelligence: 0.2, taskFit: 0.149, popularity: 0.205 },
    { coding: 0.144, agentic: 0.714, intelligence: 0.2, taskFit: 0.134, popularity: 0.142 },
  ];
  rows.forEach((row, i) => {
    const id = `acme/measured-${i}`;
    const [route] = genericRoutes({ [id]: row }, [id]);
    const expected =
      0.35 + 0.24 * row.coding + 0.14 * row.agentic + 0.10 * (row.taskFit ?? 0.5) + 0.10 * 0.5 + 0.07 * (row.popularity ?? 0.5);
    assert.equal(route?.qualityScore, expected, id);
  });
});

test('between two intelligence-only routes of one vendor the higher index wins, whatever their references were', () => {
  // gamma-2 (index 0.45) anchors on a strong reference: 0.649 + 0.019 = 0.668. zeta-2 (index 0.50)
  // anchors on a weak one: 0.529 + 0.10 (capped) = 0.629. Their own estimates say gamma-2; the index
  // they share says zeta-2. The references need not be in the catalog, only in the snapshot.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
    'acme/zeta-1': { coding: 0.1, agentic: 0.5, intelligence: 0.2 },
    'acme/zeta-2': { intelligence: 0.5 },
  };
  assert.equal(pick(intel, ['acme/gamma-2', 'acme/zeta-2']), 'acme/zeta-2');
  assert.equal(pick(intel, ['acme/zeta-2', 'acme/gamma-2']), 'acme/zeta-2');
});

test('across vendors an intelligence-only route is placed by its own reference, not lifted by another vendor', () => {
  // Same numbers, but zeta-2 belongs to another vendor: nothing ties its index to acme's, so each
  // keeps its own anchored estimate (0.668 against 0.629) and measured-looking routes of other vendors
  // are not dragged along by an estimate that was never on their scale.
  const intel: IntelMap = {
    'acme/gamma-1': { coding: 0.6, agentic: 0.5, intelligence: 0.4 },
    'acme/gamma-2': { intelligence: 0.45 },
    'other/zeta-1': { coding: 0.1, agentic: 0.5, intelligence: 0.2 },
    'other/zeta-2': { intelligence: 0.5 },
  };
  assert.equal(pick(intel, ['acme/gamma-2', 'other/zeta-2']), 'acme/gamma-2');
  assert.equal(pick(intel, ['other/zeta-2', 'acme/gamma-2']), 'acme/gamma-2');
});
