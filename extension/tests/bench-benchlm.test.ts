import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBenchlm, parseBenchlm } from '../bench-benchlm.ts';
import { fixtureJson } from './bench-fixtures.ts';

const board = fixtureJson('benchlm-leaderboard.json');
const snapshot = parseBenchlm(board, 9);
const rowOf = (model: string) => snapshot.rows.find((r) => r.model === model);
const valueOf = (model: string, label: string) => rowOf(model)?.observations.find((o) => o.label === label)?.value;

// In a category list `displayScore` is the model's overall score; the category's own score is `score`.
test('each board feeds its own facet from the score that board states', () => {
  assert.equal(valueOf('anthropic/claude-sonnet-5.5', 'BenchLM overall'), 0.8184);
  assert.equal(valueOf('anthropic/claude-sonnet-5.5', 'BenchLM coding'), 0.8169);
  assert.equal(valueOf('anthropic/claude-sonnet-5.5', 'BenchLM agentic'), 0.6912);
  assert.equal(valueOf('anthropic/claude-sonnet-5', 'BenchLM coding'), 0.5746);
  const facets = rowOf('anthropic/claude-sonnet-5.5')?.observations.map((o) => `${o.label}:${o.facet}`).sort();
  assert.deepEqual(facets, ['BenchLM agentic:agentic', 'BenchLM coding:coding', 'BenchLM overall:general']);
});

test('an estimated score counts for half of a supported one', () => {
  const supported = rowOf('anthropic/claude-sonnet-5.5')?.observations[0]?.confidence;
  const estimated = snapshot.rows.flatMap((r) => r.observations).find((o) => o.confidence < (supported ?? 0))?.confidence;
  assert.ok(supported !== undefined && estimated !== undefined);
  assert.equal(estimated, supported / 2);
});

test('the version is the methodology, the date is only shown: a changing content hash must not look like a re-baseline', () => {
  assert.equal(snapshot.source, 'benchlm');
  assert.equal(snapshot.fetchedAt, 9);
  assert.equal(snapshot.sourceVersion, 'bench-align-v5');
  assert.equal(snapshot.publishedAt, '2026-10-29');
  const rehashed = parseBenchlm({ ...(board as object), dataVersion: 'sha256:other', generatedAt: '2026-10-30T01:00:00.000Z' }, 9);
  assert.equal(rehashed.sourceVersion, snapshot.sourceVersion);
});

test('creators spelled the BenchLM way resolve to vendors, and a creator nobody can name is dropped', () => {
  const parsed = parseBenchlm({
    rankingMode: 'bench-align-v5',
    generatedAt: '2026-10-29T00:00:00Z',
    items: [
      { canonicalModelKey: 'glm-5-3', creator: 'Z.AI', score: 70, evidenceStatus: 'supported' },
      { canonicalModelKey: 'mystery-9', creator: 'Nobody Labs', score: 70, evidenceStatus: 'supported' },
      { canonicalModelKey: 'claude-opus-5-5', creator: 'Anthropic', score: Number.NaN, evidenceStatus: 'supported' },
    ],
    categories: { coding: [], agentic: [] },
  }, 1);
  assert.deepEqual(parsed.rows.map((r) => r.model), ['z-ai/glm-5.3']);
});

test('a body with no usable row, or not the leaderboard at all, is an error', () => {
  assert.throws(() => parseBenchlm({ rankingMode: 'bench-align-v5', items: [], categories: { coding: [], agentic: [] } }, 1));
  assert.throws(() => parseBenchlm({ error: 'rate limited' }, 1));
  assert.throws(() => parseBenchlm('<html></html>', 1));
});

test('fetch returns the parsed leaderboard and refuses an error status or a changed schema', async () => {
  const ok = (async () => Response.json(board)) as unknown as typeof fetch;
  assert.deepEqual(await fetchBenchlm(ok, 9), snapshot);
  const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(fetchBenchlm(down, 9));
  const changed = (async () => Response.json({ schemaVersion: '2.0', rows: [] })) as unknown as typeof fetch;
  await assert.rejects(fetchBenchlm(changed, 9));
});
