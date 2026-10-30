import test from 'node:test';
import assert from 'node:assert/strict';
import { aaSnapshot } from '../bench-aa.ts';
import { AA_INTEL } from './bench-fixtures.ts';

const rowOf = (model: string) => aaSnapshot(AA_INTEL, 1).rows.find((r) => r.model === model);
const facets = (model: string) => rowOf(model)?.observations.map((o) => o.facet).sort();

test('the 2026-10-30 AA cache keeps exactly the facets AA published for each model', () => {
  // sonnet-5.5: intelligence only. sonnet-5: coding and agentic, the intelligence index was dropped.
  assert.deepEqual(facets('anthropic/claude-sonnet-5.5'), ['general']);
  assert.deepEqual(facets('anthropic/claude-sonnet-5'), ['agentic', 'coding']);
  assert.deepEqual(facets('anthropic/claude-fable-5.1'), ['agentic', 'coding', 'general']);
});

test('values and the source version are carried as AA states them', () => {
  const snapshot = aaSnapshot(AA_INTEL, 42);
  assert.equal(snapshot.source, 'aa');
  assert.equal(snapshot.fetchedAt, 42);
  assert.equal(snapshot.sourceVersion, 'aa');
  const coding = rowOf('anthropic/claude-sonnet-5')?.observations.find((o) => o.facet === 'coding');
  assert.equal(coding?.value, 0.715);
  assert.equal(coding?.confidence, 1);
});

test('two release spellings of one model collapse to one row and the newer release wins per facet', () => {
  const snapshot = aaSnapshot({
    'anthropic/claude-3.5-sonnet': { coding: 0.302 },
    'anthropic/claude-3.5-sonnet-20240620': { coding: 0.26 },
    'anthropic/claude-3.5-sonnet-20241022': { coding: 0.4 },
  }, 1);
  const rows = snapshot.rows.filter((r) => r.model === 'anthropic/claude-3.5-sonnet');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.observations.map((o) => o.value), [0.4]);
});

test('an entry with no benchmark facet produces no row, and an AA vendor is trusted as AA states it', () => {
  const snapshot = aaSnapshot({
    'anthropic/claude-x-9': { popularity: 0.9, taskFit: 0.5 },
    'thinkingmachines/tm-1': { coding: 0.5 },
  }, 1);
  assert.deepEqual(snapshot.rows.map((r) => r.model), ['thinkingmachines/tm-1']);
});
