import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRoutes, effectiveCost, selectWithinClass, selectForTier } from '../ranking.ts';

test('subscription and free routes have zero marginal cost', () => {
  const base: any = { free: false, subscriptionLike: true, price: { input: 10, output: 50 } };
  assert.equal(effectiveCost(base), 0);
  assert.equal(effectiveCost({ ...base, free: true, subscriptionLike: false }), 0);
});

test('chooses cheapest healthy equivalent route', () => {
  const base: any = {
    modelId: 'deepseek/deepseek-v4.1-flash', selector: '', classes: ['chinese-flash-payg'],
    subscriptionLike: false, free: false, qualityScore: 0.8, reliabilityScore: 0.9,
  };
  const routes: any[] = [
    { ...base, key: 'kilo/deepseek/deepseek-v4.1-flash', provider: 'kilo', price: { input: 0.30, output: 1.20 }, health: { state: 'AVAILABLE', freshness: 'FRESH' } },
    { ...base, key: 'openrouter/deepseek/deepseek-v4.1-flash', provider: 'openrouter', price: { input: 0.15, output: 0.60 }, health: { state: 'AVAILABLE', freshness: 'FRESH' } },
  ];
  assert.equal(selectWithinClass(routes)?.key, 'openrouter/deepseek/deepseek-v4.1-flash');
});

test('healthy route beats cheaper draining route; cooldown is excluded', () => {
  const mk = (key: string, cost: number, state: string): any => ({
    key, provider: key.split('/')[0], modelId: 'm', selector: key, classes: ['x'], free: false, subscriptionLike: false,
    price: { input: cost, output: cost }, health: { state, freshness: 'FRESH' }, qualityScore: 0.8, reliabilityScore: 0.9,
  });
  assert.equal(selectWithinClass([mk('cheap/draining', 0.01, 'DRAINING'), mk('healthy/costlier', 0.02, 'AVAILABLE')])?.key, 'healthy/costlier');
  assert.equal(selectWithinClass([mk('dead/model', 0, 'COOLDOWN')]), undefined);
});

test('unknown prices fall back to best available quality', () => {
  const mk = (key: string, quality: number): any => ({
    key, provider: 'x', modelId: key, selector: key, classes: ['x'], free: false, subscriptionLike: false,
    price: {}, health: { state: 'AVAILABLE', freshness: 'UNKNOWN' }, qualityScore: quality, reliabilityScore: 0.9,
  });
  assert.equal(selectWithinClass([mk('x/weak', 0.4), mk('x/strong', 0.9)])?.key, 'x/strong');
});

test('class order dominates quality across classes', () => {
  const routes: any[] = [
    { key: 'x/luna', provider: 'x', modelId: 'luna', selector: 'x/luna', classes: ['luna-sub'], free: false, subscriptionLike: true, price: {}, health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.5, reliabilityScore: 1 },
    { key: 'x/chinese', provider: 'x', modelId: 'chinese', selector: 'x/chinese', classes: ['chinese-flash-payg'], free: false, subscriptionLike: false, price: { input: 0.01, output: 0.01 }, health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 1, reliabilityScore: 1 },
  ];
  assert.equal(selectForTier(routes, ['luna-sub', 'chinese-flash-payg'])?.route.key, 'x/luna');
});

test('provider-agnostic route builder discovers cheaper current seller from OMP model catalog', () => {
  const all = JSON.parse(fs.readFileSync('fixtures/models.json', 'utf8')).models;
  const models = all.filter((m: any) =>
    m.id === 'deepseek/deepseek-v4.1-flash' && (m.provider === 'kilo' || m.provider === 'openrouter'));
  const routes = buildRoutes(models, { ompReports: [], codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: Date.now() });
  const chosen = selectForTier(routes, ['chinese-flash-payg']);
  assert.equal(chosen?.route.provider, 'openrouter');
});

test('healthy fallback class beats a draining preferred class for new work', () => {
  const routes: any[] = [
    { key: 'x/fable', provider: 'x', modelId: 'fable', selector: 'x/fable', classes: ['fable-sub'], free: false, subscriptionLike: true, price: {}, health: { state: 'DRAINING', freshness: 'FRESH' }, qualityScore: 1, reliabilityScore: 1 },
    { key: 'y/astra', provider: 'y', modelId: 'astra', selector: 'y/astra', classes: ['astra-sub'], free: false, subscriptionLike: true, price: {}, health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.8, reliabilityScore: 1 },
  ];
  assert.equal(selectForTier(routes, ['fable-sub', 'astra-sub'])?.route.key, 'y/astra');
});

test('OpenRouter popularity is only a weak in-class quality tiebreaker', () => {
  const models: any[] = [
    { provider: 'p', id: 'deepseek/deepseek-v4.1-flash', selector: 'p/deepseek/deepseek-v4.1-flash', cost: {} },
    { provider: 'p', id: 'deepseek/deepseek-v4.2-flash', selector: 'p/deepseek/deepseek-v4.2-flash', cost: {} },
  ];
  const routes = buildRoutes(models, {
    ompReports: [], codexbar: [], localState: {}, history: {}, reservePct: 10, now: Date.now(),
    intel: {
      'deepseek/deepseek-v4.1-flash': { popularity: 0.1 },
      'deepseek/deepseek-v4.2-flash': { popularity: 0.9 },
    },
  });
  assert.equal(selectForTier(routes, ['chinese-flash-payg'])?.route.modelId, 'deepseek/deepseek-v4.2-flash');
});

test('within a semantic class, model quality chooses the model and route price chooses the seller', () => {
  const route = (key: string, modelId: string, quality: number, input: number): any => ({
    key,
    provider: key.split('/')[0],
    modelId,
    selector: key,
    classes: ['chinese-flash-payg'],
    free: false,
    subscriptionLike: false,
    price: { input, output: input * 2 },
    health: { state: 'AVAILABLE', freshness: 'FRESH' },
    qualityScore: quality,
    reliabilityScore: 0.9,
  });
  const routes = [
    route('kilo/deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 0.90, 0.30),
    route('openrouter/deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 0.90, 0.15),
    route('openrouter/z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash', 0.70, 0.01),
  ];
  assert.equal(selectWithinClass(routes)?.key, 'openrouter/deepseek/deepseek-v4.1-flash');
});

test('batch-priced variants are not candidates for live agent routing', () => {
  const routes = buildRoutes([
    { provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash:batch', cost: { input: 0.01, output: 0.02 } },
    { provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash', cost: { input: 0.15, output: 0.60 } },
  ], { ompReports: [], codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: Date.now() });
  assert.deepEqual(routes.map((r) => r.modelId), ['deepseek/deepseek-v4.1-flash']);
});

test('small-tier speed preference chooses the faster healthy model inside the same class', () => {
  const routes: any[] = [
    {
      key: 'subscription/slow-strong', provider: 'subscription', modelId: 'slow-strong', selector: 'subscription/slow-strong',
      classes: ['cheap-sub'], free: false, subscriptionLike: true, price: { input: 0, output: 0 },
      health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.95, reliabilityScore: 0.95,
      latencyMs: 1200, throughput: 40,
    },
    {
      key: 'subscription/fast-small', provider: 'subscription', modelId: 'fast-small', selector: 'subscription/fast-small',
      classes: ['cheap-sub'], free: false, subscriptionLike: true, price: { input: 0, output: 0 },
      health: { state: 'AVAILABLE', freshness: 'FRESH' }, qualityScore: 0.75, reliabilityScore: 0.9,
      latencyMs: 250, throughput: 140,
    },
  ];
  assert.equal(selectForTier(routes, ['cheap-sub'], { preference: 'speed' })?.route.key, 'subscription/fast-small');
});
