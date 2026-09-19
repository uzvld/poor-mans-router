import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, selectForTier, type OmpModelLike } from '../ranking.ts';
import { DEFAULT_POLICY } from '../policy.ts';
import type { OmpCredentialUsage } from '../telemetry.ts';

// ROADMAP #3 — "a PAYG route is never chosen over an equivalent healthy subscription".
// Decision table over synthetic routes built through the real buildRoutes()/selectForTier()
// pipeline (not hand-built NormalizedRoute stubs) so classification (policy.ts) and health
// (health.ts) run for real; only the class ladder is the real DEFAULT_POLICY.tiers.balanced.
//
// "Same model" here means the same modelId reachable through two providers/economics:
// an Anthropic subscription credential (OMP-reported) and an OpenRouter PAYG seller for
// the identical model, or — for the free/PAYG row — the same model's plain vs `:free`
// OpenRouter selector.

const NOW = Date.parse('2026-09-19T00:00:00.000Z');
const RESERVE_PCT = 10;
const BALANCED = DEFAULT_POLICY.tiers.balanced.classes;

function ompReport(provider: string, remainingFraction: number, exhausted = false): OmpCredentialUsage {
  return {
    provider,
    credentialKey: `${provider}#1`,
    fetchedAt: NOW,
    windows: [{
      id: '7d',
      shared: true,
      remainingFraction,
      resetsAt: NOW + 3_600_000,
      status: exhausted ? 'exhausted' : 'ok',
    }],
  };
}

function routesFor(models: OmpModelLike[], ompReports: OmpCredentialUsage[]) {
  return buildRoutes(models, {
    ompReports, codexbar: [], localState: {}, history: {}, intel: {}, reservePct: RESERVE_PCT, now: NOW,
  });
}

const SONNET_MODELS = [
  { provider: 'anthropic', id: 'claude-sonnet-5', selector: 'anthropic/claude-sonnet-5', cost: {} },
  { provider: 'openrouter', id: 'claude-sonnet-5', selector: 'openrouter/claude-sonnet-5', cost: { input: 3, output: 15 } },
];

test('healthy subscription beats an equally healthy PAYG route for the same model', () => {
  // anthropic is OMP-reported (subscriptionLike) with plenty of headroom (0.8 > 10% reserve) -> AVAILABLE.
  // openrouter carries no OMP report and no CodexBar row for the same model -> AVAILABLE by default.
  const routes = routesFor(SONNET_MODELS, [ompReport('anthropic', 0.8)]);
  const sub = routes.find((r) => r.key === 'anthropic/claude-sonnet-5')!;
  const payg = routes.find((r) => r.key === 'openrouter/claude-sonnet-5')!;
  assert.equal(sub.health.state, 'AVAILABLE');
  assert.equal(payg.health.state, 'AVAILABLE');
  assert.equal(sub.subscriptionLike, true);
  assert.equal(payg.subscriptionLike, false);

  const sel = selectForTier(routes, BALANCED, { allowDraining: true });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-5');
});

test('a draining subscription (inside reserve, not down) falls back to a healthy PAYG route for the same model', () => {
  // This is the documented two-pass ladder behaviour (ranking.ts selectForTier): the first
  // pass exhausts every class in order using ONLY AVAILABLE routes before admitting any
  // degraded one. A draining subscription is degraded, not healthy, so it does not
  // contradict "never beats an equivalent HEALTHY subscription" -- there is no healthy
  // subscription route in this case.
  const routes = routesFor(SONNET_MODELS, [ompReport('anthropic', 0.05)]);
  const sub = routes.find((r) => r.key === 'anthropic/claude-sonnet-5')!;
  assert.equal(sub.health.state, 'DRAINING');

  const sel = selectForTier(routes, BALANCED, { allowDraining: true });
  assert.equal(sel?.route.key, 'openrouter/claude-sonnet-5');
});

test('a cooled-down subscription is excluded entirely in favor of a healthy PAYG route for the same model', () => {
  const routes = routesFor(SONNET_MODELS, [ompReport('anthropic', 0, true)]);
  const sub = routes.find((r) => r.key === 'anthropic/claude-sonnet-5')!;
  assert.equal(sub.health.state, 'COOLDOWN');

  const sel = selectForTier(routes, BALANCED, { allowDraining: true });
  assert.equal(sel?.route.key, 'openrouter/claude-sonnet-5');
});

test('a healthy PAYG route can outrank an equally healthy free route for the same model (policy.yml ladder, not a bug)', () => {
  // Both are OpenRouter, neither is OMP-reported nor CodexBar-covered -> both default AVAILABLE.
  // decorateClasses tags the plain selector chinese-flash-payg and the `:free` selector
  // free-chinese-flash; DEFAULT_POLICY.tiers.balanced orders chinese-flash-payg BEFORE
  // free-chinese-flash. This is a human-authored class-ladder decision (policy.yml), not
  // an economics computation in ranking.ts -- flagged, not "fixed", per AGENTS.md.
  const models = [
    { provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash', selector: 'openrouter/deepseek/deepseek-v4.1-flash', cost: { input: 0.15, output: 0.6 } },
    { provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash', selector: 'openrouter/deepseek/deepseek-v4.1-flash:free', cost: {} },
  ];
  const routes = routesFor(models, []);
  const payg = routes.find((r) => r.selector === 'openrouter/deepseek/deepseek-v4.1-flash')!;
  const free = routes.find((r) => r.selector === 'openrouter/deepseek/deepseek-v4.1-flash:free')!;
  assert.equal(payg.health.state, 'AVAILABLE');
  assert.equal(free.health.state, 'AVAILABLE');
  assert.equal(payg.free, false);
  assert.equal(free.free, true);
  assert.ok(payg.classes.includes('chinese-flash-payg'));
  assert.ok(free.classes.includes('free-chinese-flash'));
  assert.ok(BALANCED.indexOf('chinese-flash-payg') < BALANCED.indexOf('free-chinese-flash'));

  const sel = selectForTier(routes, BALANCED, { allowDraining: true });
  assert.equal(sel?.route.key, 'openrouter/deepseek/deepseek-v4.1-flash');
});
