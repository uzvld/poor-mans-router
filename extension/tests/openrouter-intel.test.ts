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
