import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, selectForTier } from '../ranking.ts';

// Free-quota users are limited by request count, not tokens or dollars: a free model
// that needs fewer follow-up turns to finish a task is worth more than one that is
// merely popular. OpenRouter's `agentic_index` benchmark (task_type=agentic) is the
// closest available proxy for "gets more done per turn" already flowing through
// openrouter-intel.ts -> qualityFromIntel. The free tier's selection preference must
// rank on that signal first, not on the generic popularity-weighted quality blend
// used by every other tier.
const LIVE_NOW = Date.parse('2026-09-19T00:00:00.000Z');

function agenticVsPopularRoutes() {
  const models = [
    // Popular, benchmarks well at coding, but weak at multi-step/agentic task completion.
    { provider: 'openrouter', id: 'vendor-a/popular-model:free', selector: 'openrouter/vendor-a/popular-model:free', cost: {} },
    // Obscure (low popularity, weaker at raw coding benchmark) but excels at finishing
    // agentic tasks end-to-end -- fewer turns burned against the free-request quota.
    { provider: 'openrouter', id: 'vendor-b/agentic-model:free', selector: 'openrouter/vendor-b/agentic-model:free', cost: {} },
  ];
  return buildRoutes(models, {
    ompReports: [], codexbar: [], localState: {}, history: {},
    intel: {
      'vendor-a/popular-model': { coding: 0.9, agentic: 0.2, popularity: 0.9 },
      'vendor-b/agentic-model': { coding: 0.3, agentic: 0.95, popularity: 0.1 },
    },
    reservePct: 10, now: LIVE_NOW,
  });
}

test('sanity: generic quality preference still favors the popularity-weighted blend', () => {
  const routes = agenticVsPopularRoutes();
  const popular = routes.find((r) => r.modelId === 'vendor-a/popular-model:free')!;
  const agentic = routes.find((r) => r.modelId === 'vendor-b/agentic-model:free')!;
  assert.ok(popular.qualityScore > agentic.qualityScore, 'fixture must make quality favor the popular model');

  const sel = selectForTier(routes, ['best-free'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.modelId, 'vendor-a/popular-model:free');
});

test('free tier value preference picks the higher-agentic model over the higher-quality-blend model', () => {
  const routes = agenticVsPopularRoutes();
  const sel = selectForTier(routes, ['best-free'], { allowDraining: true, preference: 'value' });
  assert.equal(sel?.route.modelId, 'vendor-b/agentic-model:free');
});
