import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, selectForTier, type OmpModelLike } from '../ranking.ts';
import { DEFAULT_POLICY, classifyModelId, decorateClasses } from '../policy.ts';
import type { OmpCredentialUsage } from '../telemetry.ts';

// FINDING — `docs/investigations/finding-unclassified-model-names.md`.
// Class membership is a NAME-token whitelist: not a generation list, and not an economics
// computation. A new generation of a known name (`gpt-6-luna`) therefore classifies itself
// with no code change, while a new NAME (`sol`, `terra`) gets no semantic class at all and
// can only ever enter `balanced` rung 5 (`best-available`) — `frontier` has no generic paid
// rung to fall into.
//
// Routes are built through the real buildRoutes()/selectForTier() pipeline so policy.ts
// classification and health.ts verdicts run for real; only the ladder is DEFAULT_POLICY.

const NOW = Date.parse('2026-09-19T00:00:00.000Z');
const FRONTIER_OPTIONS = { allowDraining: false, preference: 'quality' } as const;

function ompReport(provider: string, remainingFraction: number): OmpCredentialUsage {
  return {
    provider,
    credentialKey: `${provider}#1`,
    fetchedAt: NOW,
    windows: [{ id: '7d', shared: true, remainingFraction, resetsAt: NOW + 3_600_000, status: 'ok' }],
  };
}

function routesFor(models: OmpModelLike[], ompReports: OmpCredentialUsage[]) {
  return buildRoutes(models, {
    ompReports, codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: NOW,
  });
}

test('a new generation of a known name classifies itself with no code change', () => {
  // The token is the product name, never the generation: this is why "GPT-6 Luna" needs
  // nothing from us while "GPT-6 Sol" needs a rule.
  for (const id of ['openai-codex/gpt-6-luna', 'openai-codex/gpt-7-luna', 'openai-codex/gpt-5.6-luna']) {
    assert.ok(classifyModelId(id).includes('luna'), `${id} must carry the luna token`);
    assert.ok(classifyModelId(id).includes('cheap'), `${id} must carry the cheap token`);
    const classes = decorateClasses(classifyModelId(id), { free: false, subscriptionLike: true });
    assert.ok(classes.includes('luna-sub'), `${id} must reach balanced rung 2`);
    assert.ok(classes.includes('cheap-sub'), `${id} must reach small rung 1`);
  }
});

test('a flagship whose name token is unknown gets a frontier rung, not just the generic paid class', () => {
  for (const id of ['openai-codex/gpt-6-sol', 'openai-codex/gpt-5.6-sol', 'openai-codex/gpt-7-terra']) {
    assert.ok(classifyModelId(id).includes('opus-ish'), `${id} must carry the opus-ish token`);
    const classes = decorateClasses(classifyModelId(id), { free: false, subscriptionLike: true });
    assert.ok(classes.includes('opus-ish-sub'), `${id} must be an "other healthy subscription frontier model"`);
    assert.ok(classes.includes('best-available'), `${id} keeps the generic paid class too`);
  }
});

test('the sol/terra token is word-bounded: unrelated catalog ids keep their own class', () => {
  for (const id of [
    'kilo/openai/gpt-5.6-sol', 'kilo/openai/gpt-5.6-sol-pro', 'kilo/~openai/gpt-sol-latest',
    'openrouter/openai/gpt-6-sol:free', 'openai-codex/gpt-6-terra',
  ]) {
    assert.ok(classifyModelId(id).includes('opus-ish'), `${id} must classify as sol/terra`);
  }
  // Substring collateral the naive `s.includes('sol')` would have swept into a frontier rung:
  // Solar (upstage), Solidity (codellama) and Lunaris (sao10k, a substring collateral of `luna`).
  for (const id of [
    'kilo/upstage/solar-pro-3', 'kilo/upstage/solar-pro4', 'openrouter/upstage/solar-pro-3:free',
    'kilo/alfredpros/codellama-7b-instruct-solidity', 'kilo/sao10k/l3-lunaris-8b',
  ]) {
    assert.equal(classifyModelId(id).includes('opus-ish'), false, `${id} must not be seen as a sol/terra model`);
  }
});

test('frontier reaches a healthy premium subscription instead of a paid strong-class route', () => {
  // The counterfactual from the finding, minimised: the OpenAI subscription holds capacity,
  // the only competing route is a paid `strong-chinese` model. Unclassified, the healthy
  // premium subscription loses that comparison; classified, it wins on ladder order.
  const models: OmpModelLike[] = [
    { provider: 'openai-codex', id: 'gpt-6-sol', selector: 'openai-codex/gpt-6-sol', cost: { input: 4, output: 20 } },
    { provider: 'kilo', id: 'qwen/qwen-max', selector: 'kilo/qwen/qwen-max', cost: { input: 1.2, output: 6 } },
  ];
  const routes = routesFor(models, [ompReport('openai-codex', 0.8)]);
  const sol = routes.find((r) => r.key === 'openai-codex/gpt-6-sol')!;
  assert.equal(sol.health.state, 'AVAILABLE');
  assert.equal(sol.subscriptionLike, true);

  const sel = selectForTier(routes, DEFAULT_POLICY.tiers.frontier.classes, FRONTIER_OPTIONS);
  assert.equal(sel?.route.key, 'openai-codex/gpt-6-sol');
  assert.equal(sel?.className, 'opus-ish-sub');
});

test('the PAYG limb is untouched: a per-token seller of the same model still has no frontier rung', () => {
  // Documented boundary of this finding, not a fix: `*-sub` classes require an OMP-reported
  // subscription credential, so `kilo/openai/gpt-6-sol` stays `best-available` only.
  const routes = routesFor(
    [{ provider: 'kilo', id: 'openai/gpt-6-sol', selector: 'kilo/openai/gpt-6-sol', cost: { input: 4, output: 20 } }],
    [],
  );
  const payg = routes.find((r) => r.key === 'kilo/openai/gpt-6-sol')!;
  assert.equal(payg.subscriptionLike, false);
  assert.equal(payg.classes.includes('opus-ish-sub'), false);
  assert.ok(payg.classes.includes('best-available'));
  assert.equal(DEFAULT_POLICY.tiers.frontier.classes.some((c) => payg.classes.includes(c)), false);
  assert.equal(selectForTier(routes, DEFAULT_POLICY.tiers.frontier.classes, FRONTIER_OPTIONS), undefined);
});
