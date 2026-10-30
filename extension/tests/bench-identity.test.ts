import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBenchModel } from '../bench-identity.ts';

// Every source spells one model differently. The canonical key must be identical across them, or the
// blend sees four half-measured models instead of one measured model.
test('one model, four spellings, one key (LMArena, Epoch, BenchLM, AA)', () => {
  const spellings: Array<[string, string | undefined]> = [
    ['Claude Sonnet 5.5 (xHigh)', 'Anthropic'],
    ['claude-sonnet-5-5_max', undefined],
    ['claude-sonnet-5-5', 'Anthropic'],
    ['anthropic/claude-sonnet-5.5-20260928', undefined],
  ];
  for (const [name, organization] of spellings) {
    assert.equal(canonicalBenchModel(name, organization)?.model, 'anthropic/claude-sonnet-5.5', name);
  }
});

test('effort is read from the suffix or the parenthetical and never leaks into the key', () => {
  assert.equal(canonicalBenchModel('Claude Sonnet 5.5 (xHigh)', 'Anthropic')?.effort, 'xhigh');
  assert.equal(canonicalBenchModel('claude-sonnet-5-5_max')?.effort, 'max');
  assert.equal(canonicalBenchModel('claude-opus-5-5_medium')?.effort, 'medium');
  assert.equal(canonicalBenchModel('GPT-6 Luna (Low)', 'OpenAI')?.effort, 'low');
  assert.equal(canonicalBenchModel('claude-sonnet-5-5', 'Anthropic')?.effort, undefined);
  // Epoch labels a missing effort `unknown`: that is no effort, not a model called "unknown".
  assert.deepEqual(canonicalBenchModel('claude-sonnet-5_unknown'), { model: 'anthropic/claude-sonnet-5' });
});

test('thinking budgets and release dates in parentheses do not change the model', () => {
  assert.equal(canonicalBenchModel('Claude Opus 4.5 (High, 32K, 20251101)', 'Anthropic')?.model, 'anthropic/claude-opus-4.5');
  assert.equal(canonicalBenchModel('Claude Sonnet 4.5 (20250929)', 'Anthropic')?.model, 'anthropic/claude-sonnet-4.5');
});

test('display names with the version before the family still meet the id spelling', () => {
  assert.equal(canonicalBenchModel('Claude 3.5 Sonnet', 'Anthropic')?.model, 'anthropic/claude-3.5-sonnet');
  assert.equal(canonicalBenchModel('anthropic/claude-3.5-sonnet')?.model, 'anthropic/claude-3.5-sonnet');
});

test('vendors come from the organization column, or from the family when the source has none', () => {
  assert.equal(canonicalBenchModel('GPT-6.1 Sol (Max)', 'OpenAI')?.model, 'openai/gpt-6.1-sol');
  assert.equal(canonicalBenchModel('gpt-6-astra_high')?.model, 'openai/gpt-6-astra');
  assert.equal(canonicalBenchModel('Kimi K3', 'Moonshot AI')?.model, 'moonshotai/kimi-k3');
  assert.equal(canonicalBenchModel('Qwen3.8 Max', 'Alibaba')?.model, 'qwen/qwen3.8-max');
});

// I9: generation digits are only comparable inside one family. Distinct models must never share a key.
test('qwen3.8 and a differently named model with the same digits are different keys (I9)', () => {
  const a = canonicalBenchModel('Qwen3.8 Max', 'Alibaba')?.model;
  const b = canonicalBenchModel('GLM 3.8 Max', 'Zhipu AI')?.model;
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('a SKU suffix that names a different model is kept: fast is not high', () => {
  assert.equal(canonicalBenchModel('anthropic/claude-opus-4.6-fast')?.model, 'anthropic/claude-opus-4.6-fast');
});

test('a model whose vendor cannot be determined is dropped, never keyed under a guess', () => {
  assert.equal(canonicalBenchModel('Totally Unknown Model 9', 'Nobody Labs'), undefined);
  assert.equal(canonicalBenchModel('', 'Anthropic'), undefined);
});

test('ISO release dates are removed after effort suffixes without merging distinct model identities', () => {
  const o3 = canonicalBenchModel('o3-2025-04-16_medium');
  const gpt = canonicalBenchModel('gpt-4.1-mini-2025-04-14');
  assert.deepEqual(o3, { model: 'openai/o3', effort: 'medium' });
  assert.deepEqual(gpt, { model: 'openai/gpt-4.1-mini' });
  assert.notEqual(o3?.model, gpt?.model);
});
