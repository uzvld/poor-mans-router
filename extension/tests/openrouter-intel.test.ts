import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenRouterHeaders,
  canonicalModelSlug,
  mergeOpenRouterIntel,
  normalizeBenchmarkRows,
  normalizeRankingRows,
  normalizeTaskClassifications,
  resolveOpenRouterKey,
} from '../openrouter-intel.ts';

test('uses the OMP-resolved OpenRouter key as bearer auth', async () => {
  assert.deepEqual(buildOpenRouterHeaders('sk-or-test'), { Authorization: 'Bearer sk-or-test' });
  let askedProvider = '';
  let askedSession = '';
  const ctx = {
    sessionManager: { getSessionId: () => 'sess-1' },
    modelRegistry: {
      getApiKeyForProvider: async (provider: string, sessionId: string) => {
        askedProvider = provider;
        askedSession = sessionId;
        return 'sk-or-existing';
      },
    },
  };
  assert.equal(await resolveOpenRouterKey(ctx as any), 'sk-or-existing');
  assert.equal(askedProvider, 'openrouter');
  assert.equal(askedSession, 'sess-1');
});

test('canonicalizes the same model sold by different gateways to one identity', () => {
  assert.equal(canonicalModelSlug('openrouter', '~deepseek/deepseek-v4.1-flash:free'), 'deepseek/deepseek-v4.1-flash');
  assert.equal(canonicalModelSlug('kilo', 'deepseek/deepseek-v4.1-flash:discounted'), 'deepseek/deepseek-v4.1-flash');
  assert.equal(canonicalModelSlug('opencode-go', 'deepseek-v4.1-flash'), 'deepseek/deepseek-v4.1-flash');
  assert.equal(canonicalModelSlug('opencode-go', 'glm-5.3-flash'), 'z-ai/glm-5.3-flash');
});

// Live evidence (fixtures/aa-bench-2026-09-22.json): Artificial Analysis indices are points on a 0–100 scale,
// and the weakest models score 0.1–1 points. `agentic_index: 1` (trinity-large-thinking, mistral-large-2512,
// nemotron-3-nano) was read as a fraction, so a model with one agentic point looked like a perfect agent, and
// 0.9, 0.8, 0.6, 0.5 and 0.1 were kept as fractions too. 19 of 100 agentic rows were affected.
test('a benchmark index is always points out of 100: one point is 0.01, never a perfect score', () => {
  const rows = (key: string, ...values: number[]) => ({ data: values.map((v, i) => ({ model_permaslug: `v/m${i}`, [key]: v })) });
  const agentic = normalizeBenchmarkRows(rows('agentic_index', 1, 0.9, 0.1, 57.9, 100), 'agentic');
  const got = Object.values(agentic).map((entry) => entry.agentic ?? Number.NaN);
  const want = [0.01, 0.009, 0.001, 0.579, 1];
  assert.equal(got.length, want.length);
  got.forEach((value, i) => assert.ok(Math.abs(value - (want[i] as number)) < 1e-12, `${value} is not ${want[i]}`));
  assert.equal(normalizeBenchmarkRows(rows('coding_index', 1), 'coding')['v/m0']?.coding, 0.01);
  assert.equal(normalizeBenchmarkRows(rows('intelligence_index', 1), 'intelligence')['v/m0']?.intelligence, 0.01);
});

test('an index outside 0..100 is clamped and a non-number is dropped', () => {
  const out = normalizeBenchmarkRows({ data: [
    { model_permaslug: 'v/over', coding_index: 140 },
    { model_permaslug: 'v/under', coding_index: -3 },
    { model_permaslug: 'v/text', coding_index: 'high' },
    { model_permaslug: 'v/null', coding_index: null },
  ] }, 'coding');
  assert.deepEqual(out, { 'v/over': { coding: 1 }, 'v/under': { coding: 0 } });
});

test('normalizes benchmark, task-fit, and popularity into bounded scores', () => {
  const coding = normalizeBenchmarkRows({ data: [
    { model_permaslug: 'deepseek/deepseek-v4.1-flash', coding_index: 82 },
  ] }, 'coding');
  const agentic = normalizeBenchmarkRows({ data: [
    { model_permaslug: 'deepseek/deepseek-v4.1-flash', agentic_index: 74 },
  ] }, 'agentic');
  const tasks = normalizeTaskClassifications({ data: { classifications: [
    { tag: 'code:general_impl', display_name: 'Code Generation', macro_category: 'code', models: [
      { id: 'deepseek/deepseek-v4.1-flash', tag_usage_share: 0.33 },
    ] },
  ] } });
  const popularity = normalizeRankingRows({ data: [
    { date: '2026-09-17', model_permaslug: 'deepseek/deepseek-v4.1-flash', total_tokens: '1000000' },
    { date: '2026-09-17', model_permaslug: 'z-ai/glm-5.3-flash', total_tokens: '100000' },
  ] });

  const merged = mergeOpenRouterIntel(coding, agentic, tasks, popularity);
  const x = merged['deepseek/deepseek-v4.1-flash'];
  assert.ok(x);
  assert.equal(x.coding, 0.82);
  assert.equal(x.agentic, 0.74);
  assert.equal(x.taskFit, 0.33);
  assert.ok((x.popularity ?? 0) > 0 && (x.popularity ?? 0) <= 1);
});
