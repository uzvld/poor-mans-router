import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutes, selectForTier } from '../ranking.ts';
import { normalizeOmpUsage } from '../telemetry.ts';
import { modelGeneration, compareModelGeneration } from '../ranking.ts';

// Secondary Sonnet selection check (after BUG D).
// All subscription routes have effectiveCost=0, and with no OpenRouter intel every
// Sonnet ties on qualityScore too. The final tie-break must never be a raw
// alphabetical model id: `claude-3-5-sonnet-20240620` must not beat `claude-sonnet-5`
// merely because "3" sorts before "s".
const LIVE_NOW = Date.parse('2026-09-19T02:56:09.916Z');

function liveSonnetRoutes() {
  const models = JSON.parse(fs.readFileSync('fixtures/models.json', 'utf8')).models
    .filter((m: any) => m.provider === 'anthropic' && String(m.id).includes('sonnet'))
    .map((m: any) => ({ provider: m.provider, id: m.id, selector: `${m.provider}/${m.id}`, name: m.name, cost: m.cost ?? {} }));
  return buildRoutes(models, {
    ompReports: normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/live-omp-usage-2026-09-19.json', 'utf8'))),
    codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: LIVE_NOW,
  });
}

test('sonnet-sub tie-break with no intel picks the newest Sonnet generation, not the alphabetically-first id', () => {
  const routes = liveSonnetRoutes();
  assert.ok(routes.length >= 8, `expected the live Anthropic Sonnet set, got ${routes.length}`);
  assert.ok(routes.every((r) => r.health.state === 'AVAILABLE'), 'precondition: all Sonnets AVAILABLE');
  const sel = selectForTier(routes, ['sonnet-sub'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-5');
});

test('model generation parses Anthropic ids into comparable numeric generations', () => {
  assert.deepEqual(modelGeneration('claude-3-5-sonnet-20240620'), [3, 5]);
  assert.deepEqual(modelGeneration('claude-sonnet-4-5-20250929'), [4, 5]);
  assert.deepEqual(modelGeneration('claude-sonnet-4-6'), [4, 6]);
  assert.deepEqual(modelGeneration('claude-sonnet-5'), [5]);
  assert.deepEqual(modelGeneration('anthropic/claude-sonnet-4.5'), [4, 5]);
});

test('newer generation sorts first; dated snapshots of the same generation tie', () => {
  assert.ok(compareModelGeneration('claude-sonnet-5', 'claude-sonnet-4-6') < 0);
  assert.ok(compareModelGeneration('claude-sonnet-4-6', 'claude-sonnet-4-5') < 0);
  assert.ok(compareModelGeneration('claude-sonnet-4-5', 'claude-3-5-sonnet-20241022') < 0);
  assert.equal(compareModelGeneration('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'), 0);
});

test('explicit OpenRouter intel still outranks generation order inside a class', () => {
  // A demonstrably better-scored older model must still win when intel says so;
  // generation order is only the tie-break for equal quality.
  const routes = liveSonnetRoutes().map((r) => (
    r.modelId === 'claude-sonnet-4-6' ? { ...r, qualityScore: r.qualityScore + 0.2 } : r
  ));
  const sel = selectForTier(routes, ['sonnet-sub'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-4-6');
});

// Generation numbers are only comparable within one model family. Across families
// ("qwen3.8-27b" vs "trinity-large-preview") a parsed digit says nothing about
// quality, so the tie-break must not reorder them: installed behaviour is preserved.
test('generation tie-break does not reorder quality-equal models of different families', () => {
  const mk = (key: string, modelId: string): any => ({
    key, provider: 'kilo', modelId, selector: key, classes: ['healthy-free'], free: true, subscriptionLike: false,
    price: {}, health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.7, reliabilityScore: 0.8,
  });
  const routes = [
    mk('kilo/qwen/qwen3.8-27b:free', 'qwen/qwen3.8-27b:free'),
    mk('kilo/arcee-ai/trinity-large-preview:free', 'arcee-ai/trinity-large-preview:free'),
  ];
  const sel = selectForTier(routes, ['healthy-free'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.key, 'kilo/arcee-ai/trinity-large-preview:free');
});
