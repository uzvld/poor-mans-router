import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntelLookup,
  intelAliases,
  intelForRoute,
  mergeOpenRouterIntel,
  normalizeBenchmarkRows,
} from '../openrouter-intel.ts';
import { buildRoutes, type OmpModelLike } from '../ranking.ts';

// The snapshot keys a model by its OpenRouter release slug; the catalog keys it by its OMP id. The
// two disagreed in three measured ways (dated keys, dotted-vs-dashed Claude versions, bare ids on
// prefix-less providers), which cost the coding index 244 of 331 reachable routes on 2026-09-23.
// These tests pin each bridge, and pin that the basename fallback refuses to guess.

const NOW = Date.parse('2026-09-23T00:00:00.000Z');

function coding(payload: unknown) {
  return normalizeBenchmarkRows(payload, 'coding');
}

test('a released-dated snapshot key reaches the undated catalog route', () => {
  const intel = coding({ data: [{ model_permaslug: 'anthropic/claude-fable-5.1-20260831', coding_index: 81.6 }] });
  assert.equal(intelForRoute(buildIntelLookup(intel), 'anthropic', 'claude-fable-5-1')?.coding, 0.816);
  // The same key also serves a route whose own id carries a date, e.g. an older catalog entry.
  assert.equal(intelForRoute(buildIntelLookup(intel), 'openrouter', 'anthropic/claude-fable-5.1-20260831')?.coding, 0.816);
});

test('a dotted version and a dashed version are the same model', () => {
  const intel = coding({ data: [{ model_permaslug: 'anthropic/claude-opus-5.5-20260723', coding_index: 78 }] });
  assert.equal(intelForRoute(buildIntelLookup(intel), 'anthropic', 'claude-opus-5-5')?.coding, 0.78);
  assert.equal(intelForRoute(buildIntelLookup(intel), 'openrouter', 'anthropic/claude-opus-5.5')?.coding, 0.78);
});

test('a provider that ships a bare id still finds the vendor-prefixed key', () => {
  const intel = coding({ data: [{ model_permaslug: 'x-ai/grok-4.6-20260810', coding_index: 76.8 }] });
  const lookup = buildIntelLookup(intel);
  assert.equal(intelForRoute(lookup, 'opencode-go', 'grok-4.6')?.coding, 0.768);
  assert.equal(intelForRoute(lookup, 'openrouter', 'x-ai/grok-4.6')?.coding, 0.768);
  // A vendor that really measured nothing stays unmeasured.
  assert.equal(intelForRoute(lookup, 'opencode-go', 'mimo-v2.6-pro'), undefined);
});

test('two vendors sharing a bare name make the fallback ambiguous, and ambiguity is never a guess', () => {
  const intel = mergeOpenRouterIntel(
    coding({ data: [{ model_permaslug: 'vendor-a/mystery-1-20260101', coding_index: 90 }] }),
    coding({ data: [{ model_permaslug: 'vendor-b/mystery-1-20260101', coding_index: 10 }] }),
  );
  const lookup = buildIntelLookup(intel);
  assert.equal(intelForRoute(lookup, 'vendor-a', 'mystery-1')?.coding, 0.9, 'the prefixed key is exact');
  assert.equal(intelForRoute(lookup, 'opencode-go', 'mystery-1'), undefined, 'the bare name matches two models');
});

test('when two releases of one model collapse into a key, the newer release wins', () => {
  const intel = mergeOpenRouterIntel(
    coding({ data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260620', coding_index: 60 }] }),
    coding({ data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260830', coding_index: 71.5 }] }),
  );
  assert.equal(intelForRoute(buildIntelLookup(intel), 'anthropic', 'claude-sonnet-5')?.coding, 0.715);
  // Order of the payload must not decide it either way.
  const reversed = mergeOpenRouterIntel(
    coding({ data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260830', coding_index: 71.5 }] }),
    coding({ data: [{ model_permaslug: 'anthropic/claude-sonnet-5-20260620', coding_index: 60 }] }),
  );
  assert.equal(intelForRoute(buildIntelLookup(reversed), 'anthropic', 'claude-sonnet-5')?.coding, 0.715);
});

test('aliases keep the stored key readable and never invent a model', () => {
  assert.deepEqual(intelAliases('anthropic/claude-opus-5-5'), [
    'anthropic/claude-opus-5-5',
    'anthropic/claude-opus-5.5',
  ]);
  assert.deepEqual(intelAliases('openai/gpt-6-astra-20260903'), [
    'openai/gpt-6-astra-20260903',
    'openai/gpt-6-astra',
  ]);
  assert.equal(intelForRoute(buildIntelLookup({}), 'anthropic', 'claude-opus-5'), undefined);
});

test('a price variant shares the model’s measurement; a different SKU does not', () => {
  const intel = coding({ data: [{ model_permaslug: 'openai/gpt-5.6-sol-20260709', coding_index: 78.3 }] });
  const lookup = buildIntelLookup(intel);
  assert.equal(Number(intelForRoute(lookup, 'kilo', 'openai/gpt-5.6-sol-discounted')?.coding?.toFixed(3)), 0.783);
  assert.equal(intelForRoute(lookup, 'kilo', 'openai/gpt-5.6-sol-pro'), undefined, 'a distinct SKU is not the base model');
  assert.equal(intelForRoute(lookup, 'openai-codex', 'gpt-5.6-sol-mini'), undefined);
});

test('a measured bare-id route reaches the routing pipeline with a real score', () => {
  const models: OmpModelLike[] = [{ provider: 'opencode-go', id: 'grok-4.6', cost: { input: 1, output: 4 } }];
  const intel = coding({ data: [{ model_permaslug: 'x-ai/grok-4.6-20260810', coding_index: 76.8 }] });
  const withIntel = buildRoutes(models, { ompReports: [], codexbar: [], localState: {}, history: {}, intel, reservePct: 10, now: NOW });
  const without = buildRoutes(models, { ompReports: [], codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: NOW });

  assert.equal(without[0]?.benchmarkPower, undefined, 'precondition: no snapshot, no measurement');
  assert.equal(without[0]?.qualityScore.toFixed(4), '0.6750', 'precondition: the no-intel default');
  assert.equal(Number(withIntel[0]?.benchmarkPower?.toFixed(3)), 0.768);
  assert.ok((withIntel[0]?.qualityScore ?? 0) > 0.7, `expected a measured score, got ${withIntel[0]?.qualityScore}`);
});
