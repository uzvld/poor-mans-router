import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeOmpUsage, parseCodexBarRows } from '../extension/telemetry.ts';
import { normalizeHistory, parseOmpStatsText } from '../extension/history.ts';
import { buildRoutes, selectForTier } from '../extension/ranking.ts';
import { DEFAULT_POLICY } from '../extension/policy.ts';

// End-to-end replay of a sanitised real telemetry snapshot (2026-09-18) through the
// full pipeline: telemetry → health → classes → ladder → in-class choice.
// Snapshot facts: openai-codex 7d exhausted; opencode-go weekly exhausted; OpenRouter paid
// wallet at $0; Anthropic healthy on OMP (5h 3 % used, 7d 12 % used) but CodexBar pace
// forecasts the weekly window will not last to reset.
const readText = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const read = (name: string) => JSON.parse(readText(name));

function routesFromSnapshot() {
  const rawUsage = read('omp-usage.json');
  return buildRoutes(read('models.json').models, {
    ompReports: normalizeOmpUsage(rawUsage),
    codexbar: parseCodexBarRows(read('codexbar-usage.json')),
    localState: {},
    history: normalizeHistory(parseOmpStatsText(readText('omp-stats.json'))),
    intel: {},
    reservePct: 10,
    now: rawUsage.generatedAt,
  });
}

test('snapshot: exhausted paid quotas are blocked, empty OpenRouter wallet blocks paid but not free', () => {
  const routes = routesFromSnapshot();
  const by = (key: string) => routes.find((r) => r.key === key)?.health.state;
  assert.equal(by('openai-codex/gpt-5.6-luna'), 'COOLDOWN');
  assert.equal(by('opencode-go/deepseek-v4.1-flash'), 'COOLDOWN');
  assert.equal(by('openrouter/deepseek/deepseek-v4.1-flash'), 'COOLDOWN');
  assert.equal(by('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'), 'AVAILABLE');
});

test('snapshot: healthy OMP Anthropic capacity outranks the pessimistic CodexBar weekly pace (I2)', () => {
  const routes = routesFromSnapshot();
  const sonnet = routes.find((r) => r.key === 'anthropic/claude-sonnet-5');
  assert.equal(sonnet?.health.state, 'AVAILABLE');
  assert.equal(sonnet?.subscriptionLike, true);
  assert.ok(sonnet?.classes.includes('sonnet-sub'));
});

test('snapshot: every tier lands on a healthy Anthropic subscription class, not the free tail', () => {
  const routes = routesFromSnapshot();
  const frontier = selectForTier(routes, DEFAULT_POLICY.tiers.frontier.classes, { allowDraining: false });
  const balanced = selectForTier(routes, DEFAULT_POLICY.tiers.balanced.classes, { allowDraining: true });
  const small = selectForTier(routes, DEFAULT_POLICY.tiers.small.classes, { allowDraining: true, preference: 'speed' });

  assert.equal(frontier?.className, 'fable-sub');
  assert.equal(balanced?.className, 'sonnet-sub');
  assert.equal(balanced?.route.key, 'anthropic/claude-sonnet-5');
  assert.equal(small?.className, 'cheap-sub');
  for (const sel of [frontier, balanced, small]) {
    assert.equal(sel?.route.provider, 'anthropic');
    assert.equal(sel?.route.free, false);
    assert.equal(sel?.route.health.state, 'AVAILABLE');
  }
});

test('snapshot: free tier value preference matches quality when no OpenRouter intel is available (no regression)', () => {
  const routes = routesFromSnapshot();
  const value = selectForTier(routes, DEFAULT_POLICY.tiers.free.classes, { allowDraining: true, preference: 'value' });
  const quality = selectForTier(routes, DEFAULT_POLICY.tiers.free.classes, { allowDraining: true, preference: 'quality' });
  assert.equal(value?.route.key, quality?.route.key);
  assert.equal(value?.route.free, true);
  assert.equal(value?.route.health.state, 'AVAILABLE');
});

test('snapshot: with Anthropic removed, the ladder degrades gracefully to the free tail', () => {
  const routes = routesFromSnapshot().filter((r) => r.provider !== 'anthropic');
  const frontier = selectForTier(routes, DEFAULT_POLICY.tiers.frontier.classes, { allowDraining: false });
  const balanced = selectForTier(routes, DEFAULT_POLICY.tiers.balanced.classes, { allowDraining: true });
  const small = selectForTier(routes, DEFAULT_POLICY.tiers.small.classes, { allowDraining: true, preference: 'speed' });
  assert.equal(frontier?.route.free, true);
  assert.equal(balanced?.route.free, true);
  assert.equal(small?.route.free, true);
});
