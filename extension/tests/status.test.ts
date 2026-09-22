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
