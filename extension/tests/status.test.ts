import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRouteStatus } from '../status.ts';

test('route status is operational and never needs account identity or secrets', () => {
  const text = formatRouteStatus({
    tier: 'balanced',
    selected: 'openrouter/z-ai/glm-5.3-flash',
    reason: 'available chinese-flash-payg; effective-cost=0.2',
    routes: [
      { key: 'anthropic/claude-sonnet-5', health: { state: 'DRAINING', freshness: 'FRESH', reason: 'quota pace' } },
      { key: 'openrouter/z-ai/glm-5.3-flash', health: { state: 'AVAILABLE', freshness: 'FRESH' } },
    ] as any,
    sources: { ompUsageAgeMs: 1000, codexBarAgeMs: 2000, openRouterIntelAgeMs: 7200000 },
  });
  assert.match(text, /tier: balanced/);
  assert.match(text, /DRAINING/);
  assert.doesNotMatch(text, /@/);
  assert.doesNotMatch(text, /sk-or-/);
});

test('mode line renders first when provided', () => {
  const text = formatRouteStatus({
    tier: 'balanced',
    mode: 'manual (opt-out — select router/* to re-enable)',
    routes: [],
    sources: {},
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^mode: manual \(opt-out/);
  assert.match(lines[1], /^tier: balanced$/);
});

test('mode line is absent when the caller does not supply one', () => {
  const text = formatRouteStatus({ tier: 'small', routes: [], sources: {} });
  assert.match(text.split('\n')[0], /^tier: small$/);
});

test('route status shows which ladder the tier was walked in, and where it came from', () => {
  const computed = formatRouteStatus({
    tier: 'frontier',
    ladder: { source: 'snapshot', order: ['fable-sub', 'opus-sub', 'astra-sub'] },
    routes: [],
    sources: {},
  });
  assert.match(computed, /ladder: computed from snapshot — fable-sub > opus-sub > astra-sub/);

  const shipped = formatRouteStatus({
    tier: 'frontier',
    ladder: { source: 'static', order: ['fable-sub', 'astra-sub', 'opus-sub'] },
    routes: [],
    sources: {},
  });
  assert.match(shipped, /ladder: shipped policy — fable-sub > astra-sub > opus-sub/);
});

test('route status carries no ladder line when the caller omits one', () => {
  const text = formatRouteStatus({ tier: 'balanced', routes: [], sources: {} });
  assert.doesNotMatch(text, /ladder:/);
});

// --- benchmarks --------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const benchSources = [
  { source: 'aa', ageMs: 3 * HOUR, models: 163, rebaselined: false, stale: false },
  { source: 'epoch', ageMs: 6 * HOUR, publishedAt: '2026-10-26', models: 160, rebaselined: false, stale: false },
  { source: 'lmarena', ageMs: 2 * HOUR, publishedAt: '2026-10-28', models: 289, rebaselined: true, stale: false },
  { source: 'benchlm', ageMs: 80 * HOUR, models: 188, rebaselined: false, stale: true },
] as const;

test('route status says how old each benchmark source is, what it covers and what is wrong with it', () => {
  const text = formatRouteStatus({ tier: 'balanced', routes: [], sources: { bench: [...benchSources] } });
  assert.match(text, /^benchmarks:$/m);
  assert.match(text, /Epoch AI: 6h old · data 2026-10-26 · 160 models$/m);
  assert.match(text, /LMArena: 2h old · data 2026-10-28 · 289 models · re-based/m);
  assert.match(text, /BenchLM: 3d old · 188 models · stale/m);
  assert.match(text, /Artificial Analysis: 3h old · 163 models$/m);
});

test('route status credits every source in use, as their licences ask, and only those', () => {
  const text = formatRouteStatus({ tier: 'balanced', routes: [], sources: { bench: [benchSources[1], benchSources[3]] } });
  assert.match(text, /Epoch AI, "Capabilities & benchmarking" \(CC BY 4\.0\)/);
  assert.match(text, /Data from BenchLM\.ai/);
  assert.doesNotMatch(text, /LMArena leaderboard dataset/);
});

test('route status shows what each source said about the selected model, and a nerf penalty', () => {
  const text = formatRouteStatus({
    tier: 'balanced',
    selected: 'anthropic/claude-sonnet-5-5',
    routes: [],
    sources: { bench: [benchSources[1]] },
    contributions: {
      model: 'anthropic/claude-sonnet-5.5',
      penalty: 0.01,
      facets: {
        coding: [
          { source: 'epoch', label: 'FrontierSWE', value: 0.619, mapped: 0.8, confidence: 0.8 },
          { source: 'lmarena', label: 'LMArena text coding', value: 1511.9, mapped: 0.7, confidence: 0.4 },
        ],
      },
    },
  });
  assert.match(text, /anthropic\/claude-sonnet-5\.5/);
  assert.match(text, /coding 0\.767/);
  assert.match(text, /FrontierSWE 0\.619→0\.800/);
  assert.match(text, /LMArena text coding 1511\.9→0\.700/);
  assert.match(text, /nerf penalty 0\.010/);
});

test('route status has no benchmark section when the caller has nothing to say about it', () => {
  const text = formatRouteStatus({ tier: 'balanced', routes: [], sources: {} });
  assert.doesNotMatch(text, /benchmarks:/);
  assert.doesNotMatch(text, /BenchLM/);
});
