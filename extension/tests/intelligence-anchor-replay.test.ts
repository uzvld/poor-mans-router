import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoutes, selectForTier } from '../ranking.ts';
import { normalizeOmpUsage } from '../telemetry.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import type { NormalizedRoute } from '../types.ts';

// Replay of the claude slice of the live 2026-10-11 catalog (fixtures/intel-anchor-claude-2026-10-11.json:
// catalog rows, the Artificial Analysis rows for anthropic/claude-*, per-route request history) with
// the subscription telemetry of the 2026-09-19 fixture, so the anthropic routes are free subscription routes.
// The intelligence-only models, claude-opus-5.5 and claude-sonnet-5.5, are scored from their lineages. Opus 5.5
// is also sold by kilo and openrouter, which have no history. Review of PR #21: after the proven routes
// cool down, the unproven seller must not win by borrowing their reliability term (I7).
// Winners below are those of origin/main (c7929a3) on the same inputs.

interface Slice {
  catalog: { provider: string; id: string; cost: Record<string, number> }[];
  intel: IntelMap;
  history: Record<string, { reliability: number; errorRate: number; requests: number; ttftMs?: number; throughput?: number }>;
}

const NOW = Date.parse('2026-09-19T02:56:09.916Z');
const slice = JSON.parse(readFileSync(new URL('../fixtures/intel-anchor-claude-2026-10-11.json', import.meta.url), 'utf8')) as Slice;
const usage = JSON.parse(readFileSync(new URL('../fixtures/live-omp-usage-2026-09-19.json', import.meta.url), 'utf8'));

function routesWithDown(down: string[]): NormalizedRoute[] {
  const localState = Object.fromEntries(down.map((key) => [key, { cooldownUntil: NOW + 3_600_000, reason: 'replay' }]));
  return buildRoutes(
    slice.catalog.filter((m) => !/:batch$/.test(m.id)).map((m) => ({ ...m, selector: `${m.provider}/${m.id}` })),
    { ompReports: normalizeOmpUsage(usage), codexbar: [], localState, history: slice.history, intel: slice.intel, reservePct: 10, now: NOW },
  );
}

const bestAvailable = (routes: NormalizedRoute[]) =>
  selectForTier(routes, ['best-available'], { allowDraining: true, preference: 'quality' })?.route.key;

const scoreOf = (routes: NormalizedRoute[], key: string) => (routes.find((r) => r.key === key) as NormalizedRoute).qualityScore;

const OPUS_5_5 = 'anthropic/claude-opus-5-5';
const SONNET_5_5 = 'anthropic/claude-sonnet-5-5';
const OPUS_5 = 'anthropic/claude-opus-5';
const KILO_OPUS_5_5 = 'kilo/anthropic/claude-opus-5.5';

test('replay, all healthy: best-available is opus-5-5, ahead of sonnet-5-5 and every unproven seller', () => {
  assert.equal(bestAvailable(routesWithDown([])), OPUS_5_5);
});

test('replay (a), opus-5-5 cooling down: best-available is the proven sonnet-5-5, not the unproven kilo opus-5.5', () => {
  const routes = routesWithDown([OPUS_5_5]);
  assert.equal(bestAvailable(routes), SONNET_5_5);
  assert.ok(scoreOf(routes, KILO_OPUS_5_5) < scoreOf(routes, SONNET_5_5), 'the unproven seller scores below the proven route');
});

test('replay (b), sonnet and opus-5-5 cooling down: best-available is the proven opus-5, not the unproven kilo opus-5.5', () => {
  const routes = routesWithDown([OPUS_5_5, SONNET_5_5, 'anthropic/claude-sonnet-5']);
  assert.equal(bestAvailable(routes), OPUS_5);
  assert.ok(scoreOf(routes, KILO_OPUS_5_5) < scoreOf(routes, OPUS_5), 'the unproven seller scores below the proven route');
});

test('replay: sellers of opus-5.5 never rank the unproven one above the proven one', () => {
  const routes = routesWithDown([]);
  assert.ok(scoreOf(routes, KILO_OPUS_5_5) <= scoreOf(routes, OPUS_5_5));
  assert.ok(scoreOf(routes, 'openrouter/anthropic/claude-opus-5.5') <= scoreOf(routes, OPUS_5_5));
});
