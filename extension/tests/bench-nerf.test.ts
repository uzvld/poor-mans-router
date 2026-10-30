import test from 'node:test';
import assert from 'node:assert/strict';
import { blendIntel, nerfPenalties } from '../bench-blend.ts';
import type { BenchHistory } from '../bench-store.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import { synthetic } from './bench-fixtures.ts';

const DAY = 86_400_000;
/** Ten models spread over 360 Elo, so a 10 Elo day is under 3% of the range: no re-baseline. */
const ELO = (i: number) => 1300 + i * 40;

type Overrides = Record<number, { drop?: number; ci?: number }>;

/** `days` daily LMArena snapshots; on the last one, model i falls by `drop` on top of `drift` for everyone. */
function series(days: number, options: { drift?: number; overrides?: Overrides } = {}): BenchHistory {
  const snapshots = Array.from({ length: days }, (_, day) => {
    const last = day === days - 1;
    const rows = Object.fromEntries(Array.from({ length: 10 }, (_, i) => {
      const o = options.overrides?.[i];
      const fall = last ? (options.drift ?? 0) + (o?.drop ?? 0) : 0;
      return [`v/m${i}`, { general: { value: ELO(i) - fall, ci: o?.ci ?? 3, label: 'LMArena text overall' } }];
    }));
    return synthetic('lmarena', rows, { fetchedAt: (day + 1) * DAY });
  });
  return { lmarena: snapshots };
}

test('a model whose rating falls beyond its own interval, against the field, is penalised by a bounded amount', () => {
  const penalty = nerfPenalties(series(5, { overrides: { 5: { drop: 12 } } })).get('v/m5');
  assert.ok(penalty !== undefined && penalty > 0 && penalty <= 0.015, `${penalty}`);
});

test('the penalty is capped below the ladder hysteresis, however deep the fall', () => {
  const penalty = nerfPenalties(series(5, { overrides: { 5: { drop: 200 } } })).get('v/m5');
  assert.equal(penalty, 0.015);
});

test('everyone falling together is the field moving, not a nerf', () => {
  assert.equal(nerfPenalties(series(5, { drift: 10 })).size, 0);
  // and one model falling more than the field is still caught on top of that drift
  const penalty = nerfPenalties(series(5, { drift: 10, overrides: { 5: { drop: 12 } } })).get('v/m5');
  assert.ok(penalty !== undefined && penalty > 0);
});

test('a fall inside the row\u2019s own interval is noise', () => {
  assert.equal(nerfPenalties(series(5, { overrides: { 5: { drop: 4, ci: 5 } } })).size, 0);
});

test('a model that rises is never penalised', () => {
  assert.equal(nerfPenalties(series(5, { overrides: { 5: { drop: -30 } } })).size, 0);
});

test('fewer than three snapshots say nothing about a trend', () => {
  assert.equal(nerfPenalties(series(2, { overrides: { 5: { drop: 100 } } })).size, 0);
});

test('a source flagged as re-based is not read for nerfs: its whole scale moved', () => {
  // 100 Elo for everyone is over a quarter of the range: a re-baseline, and model 5 falling further changes nothing.
  assert.equal(nerfPenalties(series(5, { drift: 100, overrides: { 5: { drop: 50 } } })).size, 0);
});

test('the penalty comes off every facet of the model in the blend, never below zero', () => {
  const base: IntelMap = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`v/m${i}`, { coding: 0.3 + i * 0.05, intelligence: 0.3 + i * 0.05 }]));
  const nerfed = series(5, { overrides: { 5: { drop: 12 } } });
  const penalty = nerfPenalties(nerfed).get('v/m5') as number;
  // The same latest snapshot alone has no trend, so the two blends differ by the penalty and nothing else.
  const latest = nerfed.lmarena?.at(-1);
  const twin: BenchHistory = { lmarena: latest ? [latest] : [] };
  const before = blendIntel(base, twin).intel['v/m5'];
  const after = blendIntel(base, nerfed).intel['v/m5'];
  assert.ok(Math.abs((before?.intelligence ?? 0) - (after?.intelligence ?? 0) - penalty) < 1e-9);
  assert.ok(Math.abs((before?.coding ?? 0) - (after?.coding ?? 0) - penalty) < 1e-9, 'a model that degraded is lower on every facet, not only the one measured');
  assert.ok((blendIntel({ 'v/m5': { intelligence: 0.001 } }, nerfed).intel['v/m5']?.intelligence ?? 1) >= 0);
});
