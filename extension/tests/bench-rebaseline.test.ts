import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aaSnapshot } from '../bench-aa.ts';
import { detectRebaseline } from '../bench-rebaseline.ts';
import type { BenchSnapshot, Facet } from '../bench-types.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import { AA_INTEL } from './bench-fixtures.ts';

function snapshot(rows: Record<string, Partial<Record<Facet, number>>>, version = 'v1'): BenchSnapshot {
  return {
    source: 'lmarena',
    fetchedAt: 1,
    sourceVersion: version,
    rows: Object.entries(rows).map(([model, facets]) => ({
      model,
      observations: Object.entries(facets).map(([facet, value]) => ({ facet: facet as Facet, value, confidence: 1, label: 't' })),
    })),
  };
}

/** Ten models spread evenly over 0.30–0.75 on one facet. */
const spread = (shift = 0, noise = 0) => Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`v/m${i}`, { coding: 0.3 + i * 0.05 + shift + (i % 2 ? noise : -noise) }]),
);

// Live: between 2026-10-11 and 2026-10-30 the AA Intelligence Index was re-based. 16 of the 27 Claude models
// measured on 2026-10-11 lost `intelligence`; the other five moved. Nothing in a version string said so.
test('the real AA re-baseline of 2026-10-11 → 2026-10-30 is detected', () => {
  const before = JSON.parse(readFileSync(new URL('../../fixtures/intel-anchor-claude-2026-10-11.json', import.meta.url), 'utf8')) as { intel: IntelMap };
  const verdict = detectRebaseline(aaSnapshot(before.intel, 1), aaSnapshot(AA_INTEL, 2));
  assert.equal(verdict.rebaselined, true);
  assert.match(verdict.reason ?? '', /general/);
});

test('an ordinary day is not a re-baseline: small noise, a new model, one model dropped', () => {
  const day1 = snapshot(spread());
  const day2 = snapshot({ ...spread(0, 0.004), 'v/new': { coding: 0.9 } });
  delete day2.rows[0];
  assert.deepEqual(detectRebaseline(day1, { ...day2, rows: day2.rows.filter(Boolean) }), { rebaselined: false });
});

test('every score moving together is a re-baseline even though no model lost anything', () => {
  const verdict = detectRebaseline(snapshot(spread()), snapshot(spread(0.15)));
  assert.equal(verdict.rebaselined, true);
  assert.match(verdict.reason ?? '', /coding/);
});

test('a facet that a third of the measured models stop carrying is a re-baseline', () => {
  const previous = snapshot(spread());
  const next = snapshot(Object.fromEntries(Object.entries(spread()).map(([model, facets], i) => [model, i < 4 ? {} : facets])));
  assert.equal(detectRebaseline(previous, next).rebaselined, true);
  const lessThanAThird = snapshot(Object.fromEntries(Object.entries(spread()).map(([model, facets], i) => [model, i < 2 ? {} : facets])));
  assert.equal(detectRebaseline(previous, lessThanAThird).rebaselined, false);
});

test('a changed methodology version is a re-baseline on its own', () => {
  const verdict = detectRebaseline(snapshot(spread(), 'bench-align-v5'), snapshot(spread(), 'bench-align-v6'));
  assert.equal(verdict.rebaselined, true);
  assert.match(verdict.reason ?? '', /bench-align-v5/);
});

test('with no earlier snapshot, or too few models to judge, nothing is flagged', () => {
  assert.deepEqual(detectRebaseline(undefined, snapshot(spread())), { rebaselined: false });
  assert.deepEqual(detectRebaseline(snapshot({ 'v/a': { coding: 0.3 } }), snapshot({ 'v/a': { coding: 0.9 } })), { rebaselined: false });
});
