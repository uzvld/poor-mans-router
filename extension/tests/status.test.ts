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
