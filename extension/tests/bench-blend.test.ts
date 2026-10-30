import test from 'node:test';
import assert from 'node:assert/strict';
import { blendIntel, mapToReference, pickEffortRows } from '../bench-blend.ts';
import type { BenchHistory } from '../bench-store.ts';
import type { BenchObservation, BenchSnapshot } from '../bench-types.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import { selectForTier } from '../ranking.ts';
import { DEFAULT_POLICY, DEFAULT_WEIGHTS } from '../policy.ts';
import { AA_INTEL, liveHistory, routesWith, synthetic } from './bench-fixtures.ts';

const near = (actual: number | undefined, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);

// --- mapping onto the AA scale -------------------------------------------------------------------

const reference = new Map(Array.from({ length: 8 }, (_, i) => [`v/m${i}`, 0.3 + i * 0.05] as const));
const onScale = Array.from({ length: 8 }, (_, i) => ({ model: `v/m${i}`, x: 1000 + i * 100 }));

test('a source on another scale is mapped onto the reference by the models both measured', () => {
  const map = mapToReference(onScale, reference);
  near(map(1000), 0.3);
  near(map(1700), 0.65);
  near(map(1350), 0.475);
});

test('a mapped score never leaves 0..1', () => {
  const map = mapToReference(onScale, reference);
  assert.equal(map(9000), 1);
  assert.equal(map(-9000), 0);
});

test('with fewer than five models in common the source is stretched over the reference range instead of fitted', () => {
  const few = new Map([['v/m0', 0.3], ['v/m1', 0.35], ['v/m2', 0.4]]);
  const map = mapToReference(onScale, few);
  near(map(1000), 0.3);
  near(map(1700), 0.4);
});

test('with no reference at all the source is stretched over 0..1', () => {
  const map = mapToReference(onScale, new Map());
  near(map(1000), 0);
  near(map(1700), 1);
});

test('a source whose scores are all equal maps to the middle of the reference, not to NaN', () => {
  const flat = onScale.map((p) => ({ ...p, x: 7 }));
  assert.ok(Number.isFinite(mapToReference(flat, new Map()) (7)));
});

// --- reasoning effort ----------------------------------------------------------------------------

const obs = (value: number, effort?: BenchObservation['effort']): BenchObservation => ({ facet: 'coding', value, confidence: 1, label: 'x', ...(effort ? { effort } : {}) });

test('the effort row is the better of high and xhigh, then max, then medium, then low', () => {
  assert.deepEqual(pickEffortRows([obs(0.9, 'max'), obs(0.7, 'high'), obs(0.8, 'xhigh')]), [obs(0.8, 'xhigh')]);
  assert.deepEqual(pickEffortRows([obs(0.9, 'max'), obs(0.5, 'medium')]), [obs(0.9, 'max')]);
  assert.deepEqual(pickEffortRows([obs(0.5, 'medium'), obs(0.3, 'low')]), [obs(0.5, 'medium')]);
  assert.deepEqual(pickEffortRows([obs(0.3, 'low')]), [obs(0.3, 'low')]);
});

test('rows that state no effort are left alone', () => {
  assert.deepEqual(pickEffortRows([obs(0.4), obs(0.6)]), [obs(0.4), obs(0.6)]);
});

// --- the blend, synthetic ------------------------------------------------------------------------

const base: IntelMap = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`v/m${i}-20260101`, { coding: 0.3 + i * 0.1, popularity: 0.9 }]));
const linear = (shift = 0) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`v/m${i}`, { coding: 30 + i * 10 + shift }]));
const history = (...snapshots: BenchSnapshot[]): BenchHistory =>
  snapshots.reduce<BenchHistory>((acc, s) => ({ ...acc, [s.source]: [...(acc[s.source] ?? []), s] }), {});

test('AA is overlaid on its own dated key; fields the sources do not carry are untouched', () => {
  const { intel } = blendIntel(base, history(synthetic('epoch', linear())));
  assert.deepEqual(Object.keys(intel).filter((k) => k.startsWith('v/m0')), ['v/m0-20260101']);
  assert.equal(intel['v/m0-20260101']?.popularity, 0.9);
  near(intel['v/m3-20260101']?.coding, 0.6);
});

test('a model only a source measured is added, under the canonical key, on the AA scale', () => {
  const { intel } = blendIntel(base, history(synthetic('epoch', { ...linear(), 'v/new': { coding: 75 } })));
  near(intel['v/new']?.coding, 0.75);
  assert.equal(intel['v/new']?.popularity, undefined);
});

test('a source that did not measure a model neither lowers nor raises it (I7)', () => {
  const { [`v/m0-20260101`]: only } = base;
  const rows = linear();
  delete rows['v/m0'];
  const { intel } = blendIntel(base, history(synthetic('epoch', rows)));
  assert.equal(intel['v/m0-20260101']?.coding, only?.coding);
});

test('a noisy source moves a model toward its own reading, more the more it is trusted', () => {
  const noisy = (confidence: number) => synthetic('epoch', { ...linear(), 'v/m3': { coding: { value: 90, confidence } } });
  const aa = base['v/m3-20260101']?.coding as number;
  const trusted = blendIntel(base, history(noisy(1))).intel['v/m3-20260101']?.coding as number;
  const doubted = blendIntel(base, history(noisy(0.1))).intel['v/m3-20260101']?.coding as number;
  assert.ok(trusted > doubted && doubted > aa, `${aa} < ${doubted} < ${trusted}`);
  assert.equal(blendIntel(base, history(noisy(0))).intel['v/m3-20260101']?.coding, aa);
});

test('each benchmark is mapped on its own: a hard benchmark does not drag a model below an easy one', () => {
  const rows = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`v/m${i}`, { coding: { value: 10 + i * 4, label: 'hard' } }]));
  const { intel } = blendIntel(base, history(synthetic('epoch', rows)));
  for (let i = 0; i < 6; i++) near(intel[`v/m${i}-20260101`]?.coding, 0.3 + i * 0.1, 1e-9);
});

test('the report names every contribution to a facet and the sources flagged as re-based', () => {
  const day = (v: string, fetchedAt: number, shift: number) => synthetic('epoch', linear(shift), { version: v, fetchedAt });
  const { report } = blendIntel(base, history(day('a', 1, 0), day('b', 2, 0)));
  assert.deepEqual(report.rebaselined, ['epoch']);
  const parts = report.byModel['v/m3']?.coding ?? [];
  assert.deepEqual(parts.map((p) => p.source).sort(), ['aa', 'epoch']);
  assert.ok(parts.every((p) => p.confidence > 0 && p.mapped >= 0 && p.mapped <= 1));
});

// --- the blend, on the 2026-10-30 capture --------------------------------------------------------

const live = liveHistory();
const blended = blendIntel(AA_INTEL, live);
const at = (key: string) => blended.intel[key];

test('live 2026-10-30: sonnet-5.5, which AA scores on intelligence alone, now has coding and agentic above sonnet-5', () => {
  const next = at('anthropic/claude-sonnet-5.5-20260928');
  const previous = at('anthropic/claude-sonnet-5-20260630');
  assert.ok(next?.coding !== undefined && next.agentic !== undefined, 'the independent sources supply what AA lacks');
  assert.ok((next.coding ?? 0) > (previous?.coding ?? 1), `coding ${next.coding} vs ${previous?.coding}`);
  assert.ok((next.agentic ?? 0) > (previous?.agentic ?? 1), `agentic ${next.agentic} vs ${previous?.agentic}`);
});

test('live 2026-10-30: the blend adds models AA never listed and keeps every AA key', () => {
  assert.ok(Object.keys(AA_INTEL).every((key) => key in blended.intel));
  assert.ok(Object.keys(blended.intel).length > Object.keys(AA_INTEL).length);
});

test('live 2026-10-30: every blended score is a finite number in 0..1', () => {
  for (const [key, value] of Object.entries(blended.intel)) {
    for (const facet of ['coding', 'agentic', 'intelligence'] as const) {
      const score = value[facet];
      assert.ok(score === undefined || (Number.isFinite(score) && score >= 0 && score <= 1), `${key} ${facet} ${score}`);
    }
  }
});

test('the blend does not depend on the order the sources were stored', () => {
  const reversed = blendIntel(AA_INTEL, { benchlm: live.benchlm, epoch: live.epoch, lmarena: live.lmarena });
  assert.deepEqual(reversed.intel, blended.intel);
});

// --- general, on the coding scale ------------------------------------------------------------------

// Intelligence runs at half the coding scale in this synthetic world: a model that codes at 0.6 is at 0.3.
const scaled: IntelMap = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`v/m${i}-20260101`, { coding: 0.4 + i * 0.05, intelligence: 0.2 + i * 0.025 }]));

test('general is the intelligence index mapped onto the coding scale, and intelligence itself keeps its own scale', () => {
  const { intel } = blendIntel({ ...scaled, 'v/solo-20260101': { intelligence: 0.3 } }, {});
  near(intel['v/solo-20260101']?.intelligence, 0.3);
  near(intel['v/solo-20260101']?.general, 0.6, 1e-9);
  near(intel['v/m3-20260101']?.general, 0.55, 1e-9);
});

test('a model whose general sits on the same line as its coding gets a general equal to its coding: the composite is not biased', () => {
  const { intel } = blendIntel(scaled, {});
  for (let i = 0; i < 8; i++) near(intel[`v/m${i}-20260101`]?.general, 0.4 + i * 0.05, 1e-9);
});

test('with fewer than five models measured on both there is no line to draw, so no general is made up', () => {
  const few: IntelMap = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`v/m${i}`, { coding: 0.4 + i * 0.1, intelligence: 0.2 + i * 0.05 }]));
  assert.ok(Object.values(blendIntel(few, {}).intel).every((entry) => entry.general === undefined));
});

test('a source that measures general adds to it on the same scale, with its confidence', () => {
  const rows = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`v/m${i}`, { general: 1000 + i * 100 }]));
  const { intel } = blendIntel(scaled, history(synthetic('lmarena', rows)));
  for (let i = 0; i < 8; i++) near(intel[`v/m${i}-20260101`]?.general, 0.4 + i * 0.05, 1e-9);
});

// Live 2026-10-30: opencode-go/glm-5.3-flash beats deepseek-v4-flash-vision-exp on both of AA's axes (coding
// 0.715 against 0.650, agentic 0.509 against 0.475) and on every other source. With `general` on its own, lower
// scale the vision model, which no source rated on general, outranked it because it was spared that facet.
test('live 2026-10-30: the model every source rates higher outranks the one that merely has no general score', () => {
  const routes = routesWith(blendIntel(AA_INTEL, liveHistory()).intel, { weights: DEFAULT_WEIGHTS.balanced });
  const quality = (key: string) => routes.find((r) => r.key === key)?.qualityScore ?? Number.NaN;
  assert.ok(quality('opencode-go/glm-5.3-flash') > quality('opencode-go/deepseek-v4-flash-vision-exp'));
  assert.ok(routes.find((r) => r.key === 'opencode-go/glm-5.3-flash')?.classes.includes('chinese-flash-payg'));
  assert.ok(DEFAULT_POLICY.tiers.balanced.classes.includes('chinese-flash-payg'));
});

// A model AA does not list at all is still measured by the other sources, and wins on that evidence.
test('live 2026-10-30: a model only the independent sources measured can lead its class', () => {
  const routes = routesWith(blendIntel(AA_INTEL, liveHistory()).intel, { weights: DEFAULT_WEIGHTS.balanced });
  const pick = selectForTier(routes, ['chinese-flash-payg'], { allowDraining: true, preference: 'quality' });
  assert.equal(pick?.route.key, 'opencode-go/deepseek-v4.1-flash');
});
