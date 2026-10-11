import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutes, selectForTier } from '../ranking.ts';
import { normalizeOmpUsage } from '../telemetry.ts';
import { normalizeBenchmarkRows, type IntelMap } from '../openrouter-intel.ts';

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

const winner = (intel: IntelMap, ids: string[]) =>
  selectForTier(routesFor(intel, ids), ['sonnet-sub'], { allowDraining: true, preference: 'quality' })?.route.modelId;

const SONNET_5 = { coding: 0.715, agentic: 0.436, intelligence: 0.382 };

test('the intelligence index is read from a benchmark row even when coding and agentic are null', () => {
  const intel = normalizeBenchmarkRows(
    { data: [{ model_permaslug: 'anthropic/claude-sonnet-5.5-20260928', intelligence_index: 56, coding_index: null, agentic_index: null }] },
    'intelligence',
  );
  assert.deepEqual(intel, { 'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 } });
});

test('a model with only an intelligence index beats a predecessor with a lower one (live 2026-10-11)', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.56 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-5-5']), 'claude-sonnet-5-5');
});

test('an intelligence-only model does not win when its index is lower than the measured sibling', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.3 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-5-5']), 'claude-sonnet-5');
});

test('when every candidate has coding, intelligence does not decide: coding still outranks it', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': { coding: 0.8, agentic: 0.5, intelligence: 0.3 },
    'anthropic/claude-sonnet-5.5-20260928': { coding: 0.7, agentic: 0.4, intelligence: 0.9 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-5-5']), 'claude-sonnet-5');
});

test('a candidate with no intelligence index cannot be compared on it, so existing scoring stands', () => {
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { popularity: 0.9 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-5-5']), 'claude-sonnet-5');
});

test('in intelligence mode a model with no benchmark at all never outranks a measured one (I7)', () => {
  // Live 2026-10-11 best-free: tencent/hy3 has only popularity, qwen3.8-27b has coding, agentic and a
  // low intelligence index, and a third route has intelligence only. A neutral prior for hy3 would
  // sit above qwen's intelligence-scaled score and flip the class.
  const intel: IntelMap = {
    'anthropic/claude-sonnet-5-20260630': SONNET_5,
    'anthropic/claude-sonnet-5.5-20260928': { intelligence: 0.3 },
    'anthropic/claude-sonnet-4-6': { popularity: 0.9 },
  };
  assert.equal(winner(intel, ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6']), 'claude-sonnet-5');
});
