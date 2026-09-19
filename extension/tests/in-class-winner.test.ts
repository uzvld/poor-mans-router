import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutes, selectForTier } from '../ranking.ts';
import { normalizeOmpUsage } from '../telemetry.ts';
import { normalizeHistory } from '../history.ts';

// In-class winner policy (BUG D secondary). Order inside the winning class:
//   health → tier economics → explicit quality/intel → measured reliability
//   → same-family current/bootstrap model → newer generation → lexical (last resort)
const LIVE_NOW = Date.parse('2026-09-19T02:56:09.916Z');
const liveHistory = () => normalizeHistory(JSON.parse(fs.readFileSync('fixtures/live-omp-stats-2026-09-19.json', 'utf8')));

function liveSonnetRoutes(opts: { history?: boolean } = {}) {
  const models = JSON.parse(fs.readFileSync('fixtures/models.json', 'utf8')).models
    .filter((m: any) => m.provider === 'anthropic' && String(m.id).includes('sonnet'))
    .map((m: any) => ({ provider: m.provider, id: m.id, selector: `${m.provider}/${m.id}`, name: m.name, cost: m.cost ?? {} }));
  return buildRoutes(models, {
    ompReports: normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/live-omp-usage-2026-09-19.json', 'utf8'))),
    codexbar: [], localState: {}, history: opts.history ? liveHistory() : {}, intel: {}, reservePct: 10, now: LIVE_NOW,
  });
}

// --- 1. cold-start reliability prior -------------------------------------------------

test('LIVE: balanced bootstrap claude-sonnet-5 wins sonnet-sub over never-used older siblings (live omp-stats history)', () => {
  // Live 2026-09-19: claude-sonnet-5 has 76 measured requests (reliability 0.697);
  // every other Sonnet has zero history. The measured, actually-used model must win.
  const routes = liveSonnetRoutes({ history: true });
  const sel = selectForTier(routes, ['sonnet-sub'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-5');
});

test('zero-history route does not automatically outrank a measured healthy route', () => {
  const models = [
    { provider: 'p', id: 'fam-2', selector: 'p/fam-2', cost: {} },
    { provider: 'p', id: 'fam-1', selector: 'p/fam-1', cost: {} },
  ];
  const routes = buildRoutes(models, {
    ompReports: [], codexbar: [], localState: {}, intel: {}, reservePct: 10, now: LIVE_NOW,
    history: { 'p/fam-1': { reliability: 0.7, errorRate: 0.3, requests: 50 } },
  });
  const measured = routes.find((r) => r.key === 'p/fam-1')!;
  const unmeasured = routes.find((r) => r.key === 'p/fam-2')!;
  assert.ok(unmeasured.reliabilityScore <= measured.reliabilityScore,
    `unmeasured prior ${unmeasured.reliabilityScore} must not exceed measured ${measured.reliabilityScore}`);
  assert.ok(unmeasured.qualityScore <= measured.qualityScore,
    `unmeasured quality ${unmeasured.qualityScore} must not exceed measured ${measured.qualityScore}`);
});

// --- 2. bootstrap/current-model affinity: a SCOPED tie-break only ---------------------

const mk = (key: string, over: Partial<any> = {}): any => ({
  key, provider: key.split('/')[0], modelId: key.split('/').slice(1).join('/'), selector: key,
  classes: ['c'], free: false, subscriptionLike: true, price: {},
  health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.7, reliabilityScore: 0.5, ...over,
});

test('same-family, otherwise-equal candidates: the current/bootstrap model wins over a newer sibling', () => {
  // All comparator inputs tie. Without affinity the generation rule would pick 4-6 over 4-5.
  const routes = [mk('anthropic/claude-sonnet-4-6'), mk('anthropic/claude-sonnet-4-5')];
  const sel = selectForTier(routes, ['c'], { allowDraining: true, preference: 'quality', currentKey: 'anthropic/claude-sonnet-4-5' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-4-5');
});

test('bootstrap affinity does not override tier economics: small-tier bootstrap Luna loses to cheaper Haiku', () => {
  // Distinct families, PAYG prices differ → cost decides; the bootstrap marker must be inert.
  const routes = [
    mk('p/gpt-5.6-luna', { classes: ['cheap-flash'], subscriptionLike: false, price: { input: 1.0, output: 4.0 } }),
    mk('p/claude-haiku-4-5', { classes: ['cheap-flash'], subscriptionLike: false, price: { input: 0.2, output: 0.8 } }),
  ];
  const sel = selectForTier(routes, ['cheap-flash'], { allowDraining: true, preference: 'speed', currentKey: 'p/gpt-5.6-luna' });
  assert.equal(sel?.route.key, 'p/claude-haiku-4-5');
});

test('bootstrap affinity does not override explicit intel: a stronger-scored sibling still wins', () => {
  const routes = [
    mk('anthropic/claude-sonnet-4-6', { qualityScore: 0.9 }),
    mk('anthropic/claude-sonnet-5', { qualityScore: 0.7 }),
  ];
  const sel = selectForTier(routes, ['c'], { allowDraining: true, preference: 'quality', currentKey: 'anthropic/claude-sonnet-5' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-4-6');
});

test('bootstrap affinity is family-scoped: it does not pull a different-family bootstrap over an equal candidate', () => {
  // Equal inputs, different families, bootstrap is one of them. Affinity must stay inert;
  // the deterministic lexical fallback (existing behaviour) decides.
  const routes = [mk('kilo/qwen/qwen3.8-27b:free'), mk('kilo/arcee-ai/trinity-large-preview:free')];
  const sel = selectForTier(routes, ['c'], { allowDraining: true, preference: 'quality', currentKey: 'kilo/qwen/qwen3.8-27b:free' });
  assert.equal(sel?.route.key, 'kilo/arcee-ai/trinity-large-preview:free');
});

test('lexical order is only the final deterministic tie-break', () => {
  // Same family, equal inputs, no bootstrap, equal generation → lexical decides.
  const routes = [mk('anthropic/claude-sonnet-4-5-20250929'), mk('anthropic/claude-sonnet-4-5')];
  const sel = selectForTier(routes, ['c'], { allowDraining: true, preference: 'quality' });
  assert.equal(sel?.route.key, 'anthropic/claude-sonnet-4-5');
});
