import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOmpStatsText, normalizeHistory } from '../history.ts';

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
