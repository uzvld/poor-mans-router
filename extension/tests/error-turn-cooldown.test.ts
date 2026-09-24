import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import adaptiveRouter from '../index.ts';
import { evaluateRouteHealth } from '../health.ts';

// Live incident, 2026-09-19 14:52 and 14:57 (+02:00): the `d3b888e` fix for the repeated
// `[omp:pmr] pmr/free -> kilo/arcee-ai/trinity-large-preview:free` marker was installed at
// 14:43 and the identical four-marker, zero-content reply happened again twice.
//
// Why the fix did not hold: it recorded the cooldown from `auto_retry_start`, but OMP's
// native retry engine never emits that event for the failure in question. OMP 18.2.6
// `isRetryableError` returns false for every 4xx except 408/429, and its non-retryable
// message list includes "not found" -- so a 404 "model does not exist" ends the turn
// directly: the assistant message carries `stopReason: "error"` + `errorMessage`, and the
// only extension hook that observes it is `agent_end`. 50/50 OMP processes that hit the 404
// today logged zero `auto_retry_start`/`retry_fallback_applied` events.
//
// The router's `agent_end` handler then called `recordSuccess` unconditionally.
//
// This test drives the path OMP actually takes: a turn that ends in a provider error, with
// no retry events in between, must cool the failed route down so the next fresh process
// (Multica spawns one per attempt, all sharing this state.json) picks a different one.

// The store resolves its path when the extension is constructed, so the harness owns it: a
// scratch file keeps the developer's own state.json out of the suite (AGENTS.md) while keeping
// the property this test needs — two independent extension instances sharing one on-disk file.
const SCRATCH_STATE = path.join(os.tmpdir(), `pmr-test-state-error-turn-${process.pid}.json`);
const STATE_FILE = SCRATCH_STATE;
const ORIGINAL_STATE_FILE = process.env.PMR_STATE_FILE;

interface EventHarness {
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
  ctx: unknown;
}

function harness(models: unknown[], currentModel: unknown) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: Array<{ provider?: string; id?: string }> = [];
  let current = currentModel;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: unknown) {
      setModelCalls.push(m as { provider?: string; id?: string });
      current = m;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m: any) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  adaptiveRouter(pi);
  return {
    handlers, ctx, setModelCalls,
    setCurrent(model: unknown) { current = model; },
    async emit(name: string, event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

async function boot(h: EventHarness): Promise<void> {
  for (const f of h.handlers.get('session_start')!) await f({}, h.ctx);
}

async function turn(h: EventHarness): Promise<void> {
  for (const f of h.handlers.get('before_agent_start')!) await f({}, h.ctx);
}

// Shape of OMP's `agent_end` extension event: the full message list, last assistant message
// carrying the provider error the way `logProviderTurnError` logs it.
async function endInError(h: EventHarness, pick: { provider?: string; id?: string }, errorMessage: string, errorStatus = 404): Promise<void> {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage, errorStatus, provider: pick.provider, model: pick.id },
  ];
  for (const f of h.handlers.get('agent_end')!) await f({ messages }, h.ctx);
}

const virtualFree = { provider: 'pmr', id: 'free', cost: {} };
const primaryFree = { provider: 'kilo', id: 'arcee-ai/trinity-large-preview:free', cost: { input: 0, output: 0 } };
const secondaryFree = { provider: 'openrouter', id: 'nvidia/nemotron:free', cost: { input: 0, output: 0 } };

test.beforeEach(() => {
  fs.rmSync(SCRATCH_STATE, { force: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ routes: {} }));
});

test.after(() => {
  fs.rmSync(SCRATCH_STATE, { force: true });
  if (process.env.PMR_STATE_FILE !== SCRATCH_STATE) return;
  if (ORIGINAL_STATE_FILE === undefined) delete process.env.PMR_STATE_FILE;
  else process.env.PMR_STATE_FILE = ORIGINAL_STATE_FILE;
});

test('a concrete native fallback is not replaced with a different PMR candidate mid-retry', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const h = harness([balanced, paid, sibling, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), paid);
  h.setCurrent(secondaryFree);
  await h.emit('retry_fallback_applied', { from: `kilo/${paid.id}`, to: `openrouter/${secondaryFree.id}` });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 1000 });
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.equal(h.setModelCalls.length, 1);
});

test('a turn that ends in a non-retried "model does not exist" provider error cools the route down so a fresh process picks a different one', async () => {
  const models = [virtualFree, primaryFree, secondaryFree];

  const h1 = harness(models, virtualFree);
  await boot(h1);
  await turn(h1);
  assert.equal(h1.setModelCalls.length, 1, 'precondition: process 1 switched once');
  const firstPick = h1.setModelCalls[0];

  // No auto_retry_start: OMP does not retry a 404. The turn just ends.
  await endInError(h1, firstPick, `404 The requested model '${firstPick.id}' does not exist. Please use an exact model id as listed on /api/gateway/models.`);

  const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).routes[`${firstPick.provider}/${firstPick.id}`];
  assert.ok(persisted?.cooldownUntil > Date.now(), `failed route must be cooled down on disk, got ${JSON.stringify(persisted)}`);
  assert.equal(persisted.lastSuccessAt, undefined, 'an error turn must never be recorded as a success');

  const h2 = harness(models, virtualFree);
  await boot(h2);
  await turn(h2);
  assert.equal(h2.setModelCalls.length, 1, 'process 2 must also switch (it starts on the virtual model again)');
  assert.notEqual(
    h2.setModelCalls[0].id,
    firstPick.id,
    `process 2 re-selected the route that just hard-404d (${firstPick.id}); the error turn was never recorded`,
  );
});

test('a turn that ends in an unclassified provider error records the failure without a success stamp', async () => {
  const models = [virtualFree, primaryFree, secondaryFree];
  const h1 = harness(models, virtualFree);
  await boot(h1);
  await turn(h1);
  const pick = h1.setModelCalls[0];

  await endInError(h1, pick, '400 Bad Request: messages must not be empty');

  const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).routes[`${pick.provider}/${pick.id}`];
  assert.ok(persisted?.lastFailureAt, 'failure must be recorded');
  assert.equal(persisted.lastSuccessAt, undefined, 'an error turn must never be recorded as a success');
  assert.equal(persisted.cooldownUntil, undefined, 'a one-off request error is not catalog drift and must not cool the route down');
});

test('a terminal credit rejection prevents a fresh balanced session from selecting the failed paid route', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paidKilo = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const paidAlternate = { provider: 'openrouter', id: paidKilo.id, cost: { input: 2, output: 2 } };
  const models = [balanced, paidKilo, paidAlternate];
  const first = harness(models, balanced);
  await boot(first);
  await turn(first);
  assert.equal(first.ctx.models.current(), paidKilo);

  // Also learn a terminal 402 when no native retry event is delivered.
  await endInError(first, paidKilo, '402 Add credits to continue, or switch to a free model', 402);

  const next = harness(models, balanced);
  await boot(next);
  await turn(next);
  assert.equal(next.ctx.models.current(), paidAlternate);
});

test('virtual native fallback escapes an empty paid wallet without blocking its free routes', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const models = [balanced, paid, sibling, primaryFree];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), paid);

  h.setCurrent(balanced);
  await h.emit('retry_fallback_applied', { from: `kilo/${paid.id}:off`, to: 'pmr/balanced', role: 'default' });
  await h.emit('auto_retry_start', {
    errorMessage: '402 Add credits to continue, or switch to a free model', delayMs: 0,
  });
  assert.equal(h.ctx.models.current(), primaryFree, 'recover before the virtual transport guard aborts');

  await h.emit('auto_retry_end');
  await turn(h);
  assert.equal(h.ctx.models.current(), primaryFree, 'own recovery stays managed without retrying paid siblings');

  const fresh = harness(models, balanced);
  await boot(fresh);
  await turn(fresh);
  assert.equal(fresh.ctx.models.current(), primaryFree, 'a fresh process remembers the paid-wallet rejection');
});

test('recovering a virtual fallback preserves frontier instead of adopting the fallback balanced tier', async () => {
  const frontier = { provider: 'pmr', id: 'frontier', cost: {} };
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'z-ai/glm-5', cost: { input: 1, output: 1 } };
  const flash = { provider: 'openrouter', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const h = harness([frontier, balanced, paid, flash, secondaryFree], frontier);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), paid);
  h.setCurrent(balanced);
  await h.emit('retry_fallback_applied', { from: `kilo/${paid.id}:high`, to: 'pmr/balanced', role: 'default' });
  await h.emit('auto_retry_start', { errorMessage: '402 Add credits to continue', delayMs: 0 });
  assert.equal(h.ctx.models.current(), secondaryFree, 'frontier has no paid cheap-flash rung');
});

test('a manual selection between native fallback and retry is not overwritten by virtual recovery', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(balanced);
  await h.emit('retry_fallback_applied', { from: `kilo/${primaryFree.id}`, to: 'pmr/balanced' });
  h.setCurrent(secondaryFree);
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 1000 });
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.equal(h.setModelCalls.length, 1, 'only the initial PMR switch is allowed');
});

test('virtual recovery cannot revive manual opt-out even after returning to the old PMR pick', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree);
  await turn(h); // Observe manual opt-out.
  h.setCurrent(primaryFree);
  await turn(h); // Returning to the old pick is not a new opt-in.
  h.setCurrent(balanced);
  await h.emit('retry_fallback_applied', { from: `kilo/${primaryFree.id}`, to: 'pmr/balanced' });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 1000 });
  assert.equal(h.ctx.models.current(), balanced);
  assert.equal(h.setModelCalls.length, 1);
});

test('an empty-wallet rejection does not shorten a sibling model-not-found cooldown', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const now = Date.now();
  const siblingKey = `kilo/${sibling.id}`;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ routes: {
    [siblingKey]: { cooldownUntil: now + 24 * 60 * 60_000, lastFailureAt: now, reason: 'model not found' },
  } }));
  const h = harness([balanced, paid, sibling, primaryFree], balanced);
  await boot(h);
  await turn(h);
  await endInError(h, paid, '402 Add credits to continue', 402);
  const local = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).routes[siblingKey];
  const health = evaluateRouteHealth({ provider: 'kilo', modelId: sibling.id, free: false }, {
    ompReports: [], codexbar: [], reservePct: 10, now: now + 10 * 60_000, local,
  });
  assert.equal(health.state, 'COOLDOWN', 'catalog drift must still veto after the wallet backoff expires');
});

test('a request requiring more credits does not reject every paid model on the provider', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const h = harness([balanced, paid, sibling, primaryFree], balanced);
  await boot(h);
  await turn(h);
  await endInError(h, paid, '402 Payment required: this request requires more credits. Reduce max_tokens.', 402);
  const fresh = harness([balanced, paid, sibling, primaryFree], balanced);
  await boot(fresh);
  await turn(fresh);
  assert.equal(fresh.ctx.models.current(), sibling);
});

test('a fallback from a different concrete route is not mistaken for the router own failed pick', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree); // Manual change, not yet observed by before_agent_start.
  h.setCurrent(balanced); // OMP fell back from that different concrete model.
  await h.emit('retry_fallback_applied', { from: `openrouter/${secondaryFree.id}`, to: 'pmr/balanced' });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 1000 });
  assert.equal(h.ctx.models.current(), balanced);
  assert.equal(h.setModelCalls.length, 1);
});

test('virtual recovery cannot strand the failed model remote-compacted history', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const codex = { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses', cost: { input: 1, output: 1 } };
  const models: unknown[] = [balanced, codex];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), codex);
  models.push(secondaryFree);
  h.ctx.sessionManager.getBranch = () => [{ type: 'compaction', method: 'remote' }];
  h.setCurrent(balanced);
  await h.emit('retry_fallback_applied', { from: `openai-codex/${codex.id}`, to: 'pmr/balanced' });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 1000 });
  assert.equal(h.ctx.models.current(), balanced, 'leave the guard fail-closed rather than lose history');
  assert.equal(h.setModelCalls.length, 1);
});

test('a wallet message does not broaden a failed subscription route across independent credentials', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const paid = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    routes: {},
    telemetry: { fetchedAt: Date.now(), codexbar: [], ompReports: [
      { provider: 'kilo', windows: [{ remainingFraction: 0.8, status: 'ok' }] },
    ] },
  }));
  const models = [balanced, paid, sibling];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), paid);
  await endInError(h, paid, '402 Add credits to continue', 402);
  const fresh = harness(models, balanced);
  await boot(fresh);
  await turn(fresh);
  assert.equal(fresh.ctx.models.current(), sibling);
});
