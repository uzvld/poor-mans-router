import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOmpStatsText, normalizeHistory } from '../history.ts';
import { buildRoutes, selectForTier } from '../ranking.ts';

test('parses omp stats output even when CLI prepends a sync line', () => {
  const raw = fs.readFileSync('fixtures/omp-stats.json', 'utf8');
  const parsed = parseOmpStatsText(raw);
  assert.equal(parsed.overall.totalRequests, 1157);
});

test('normalizes reliability and performance by concrete provider/model route', () => {
  const raw = parseOmpStatsText(fs.readFileSync('fixtures/omp-stats.json', 'utf8'));
  const history = normalizeHistory(raw);
  const luna = history['openai-codex/gpt-5.6-luna'];
  assert.ok(luna);
  assert.equal(luna.reliability, 1);
  assert.ok((luna.ttftMs ?? 0) > 0);
  const kiloFree = history['kilo/kilo-auto/free'];
  assert.ok(kiloFree);
  assert.ok(kiloFree.reliability < 0.1);
});

// Live 2026-10-01: omp stats reported claude-3-haiku-20240307 with 36/36 failed requests and
// `avgTokensPerSecond: 0, avgTtft: null`. A 0 is "no successful output", not a measured
// speed, yet the speed comparator treats any finite throughput as measured and ranked the
// dead route ahead of its unmeasured sibling (pmr/small kept choosing it).
test('a route with no successful requests has no measured speed and cannot win pmr/small on it', () => {
  const history = normalizeHistory({
    byModel: [{
      provider: 'anthropic', model: 'zz-retired', totalRequests: 36, successfulRequests: 0, failedRequests: 36,
      errorRate: 1, avgTtft: null, avgTokensPerSecond: 0, avgDuration: 490,
    }],
  });
  assert.equal(history['anthropic/zz-retired'].throughput, undefined);
  assert.equal(history['anthropic/zz-retired'].ttftMs, undefined);

  const price = { input: 0.25, output: 1.25 };
  const models = [
    { provider: 'anthropic', id: 'zz-retired', selector: 'anthropic/zz-retired', cost: price },
    { provider: 'anthropic', id: 'aa-fresh', selector: 'anthropic/aa-fresh', cost: price },
  ];
  const routes = buildRoutes(models, { ompReports: [], codexbar: [], localState: {}, history, intel: {}, reservePct: 10, now: Date.now() });
  const pick = selectForTier(routes, ['best-available'], { allowDraining: true, preference: 'speed' });
  assert.equal(pick?.route.key, 'anthropic/aa-fresh');
});
