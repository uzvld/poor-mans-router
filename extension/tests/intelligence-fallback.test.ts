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

test('in intelligence mode a newer model with no benchmark at all does not outrank a measured one (I7)', () => {
  // sonnet-5-5 has no row; it is the newest, so it only loses if it scores below the weakest measured
  // route. A floor at or above the best measured score hands it the win on generation.
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-4-5': { intelligence: 0.3 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5']), 'claude-sonnet-5');
});

test('an unmeasured route ties nothing: it loses to the only measured route even when it is newer', () => {
  // One measured route: a floor equal to its own score would tie, and the generation tie-break
  // would then pick the unmeasured newer model.
  const intel: IntelMap = { 'anthropic/claude-sonnet-4-5': { intelligence: 0.5 } };
  assert.equal(winner(intel, ['claude-sonnet-4-5', 'claude-sonnet-5']), 'claude-sonnet-4-5');
});

test('the intelligence basis applies under the value and speed preferences used by free and small', () => {
  // Equal agentic (0.5) so `value`, which leads on it, falls through to quality; speed has no latency
  // or cost difference on a subscription, so it also falls through to quality.
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': { coding: 0.715, agentic: 0.5, intelligence: 0.382 },
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 },
  };
  assert.equal(winner(intel, PAIR, 'value'), 'claude-sonnet-5-5');
  assert.equal(winner(intel, PAIR, 'speed'), 'claude-sonnet-5-5');
});
