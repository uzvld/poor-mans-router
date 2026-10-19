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
  let switchResult = true;
  const branch: Array<{ type: string; model?: string; role?: string; modelRole?: string; resolvedModelIsFallback?: boolean }> = [
    { type: 'session_init', modelRole: 'default' },
  ];
  function recordModel(model: unknown, role: string) {
    if (!model || typeof model !== 'object' || !('provider' in model) || !('id' in model)) return;
    branch.push({ type: 'model_change', model: `${model.provider}/${model.id}`, role, resolvedModelIsFallback: false });
  }
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
      if (!switchResult) return false;
      setModelCalls.push(m as { provider?: string; id?: string });
      current = m;
      recordModel(m, 'default');
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
    sessionManager: { getBranch: () => branch, getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  adaptiveRouter(pi);
  return {
    handlers, ctx, setModelCalls,
    setCurrent(model: unknown, role = 'default') { current = model; recordModel(model, role); },
    setSwitchResult(result: boolean) { switchResult = result; },
    async emit(name: string, event: unknown = {}) {
      if (name === 'retry_fallback_applied' && event && typeof event === 'object' && 'to' in event
        && typeof event.to === 'string') {
        const pending = branch.at(-1);
        if (pending?.type === 'model_change' && pending.model === event.to && pending.role === 'default') {
          pending.role = 'fallback';
          pending.resolvedModelIsFallback = true;
        } else branch.push({ type: 'model_change', model: event.to, role: 'fallback', resolvedModelIsFallback: true });
      }
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
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

test('a terminal expired API key makes a fresh managed session avoid the failed route', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const expired = { provider: 'opencode-go', id: 'glm-5.3-flash', cost: { input: 1, output: 1 } };
  const alternate = { provider: 'openrouter', id: 'qwen/qwen3.7-flash', cost: { input: 2, output: 2 } };
  const models = [balanced, expired, alternate];
  const first = harness(models, balanced);
  await boot(first);
  await turn(first);
  assert.equal(first.ctx.models.current(), expired);

  await endInError(first, expired,
    '401 This API key has expired. Create a new API key in OpenCode Console. (type=authentication_error param=api_key_expired)', 401);

  const next = harness(models, balanced);
  await boot(next);
  await turn(next);
  assert.equal(next.ctx.models.current(), alternate, 'the known expired key must not beat a working fallback');

  const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).routes['opencode-go/glm-5.3-flash'];
  assert.ok(persisted.cooldownUntil > Date.now(), 'the refusal must persist across processes');
  assert.equal(evaluateRouteHealth({ provider: 'opencode-go', modelId: expired.id, free: false }, {
    ompReports: [], codexbar: [], local: persisted, reservePct: 10, now: persisted.cooldownUntil + 1,
  }).state, 'AVAILABLE', 'a credential replacement must not require deleting persistent state');
});

test('native credential recovery after an API-key rejection does not cool a successful route', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const primary = { provider: 'opencode-go', id: 'glm-5.3-flash', cost: { input: 1, output: 1 } };
  const alternate = { provider: 'openrouter', id: 'qwen/qwen3.7-flash', cost: { input: 2, output: 2 } };
  const models = [balanced, primary, alternate];
  const first = harness(models, balanced);
  await boot(first);
  await turn(first);
  await first.emit('auto_retry_start', { errorMessage: '401 Invalid API key (code=invalid_api_key)', delayMs: 0 });
  await first.emit('auto_retry_end');
  await first.emit('agent_end', { messages: [
    { role: 'assistant', provider: primary.provider, model: primary.id, stopReason: 'error',
      errorMessage: '401 Invalid API key (code=invalid_api_key)' },
    { role: 'assistant', provider: primary.provider, model: primary.id, stopReason: 'stop',
      content: [{ type: 'text', text: 'Recovered using the healthy sibling credential' }] },
  ] });

  const next = harness(models, balanced);
  await boot(next);
  await turn(next);
  assert.equal(next.ctx.models.current(), primary, 'native recovery must retain the healthy sibling credential');
});

test('an API-key rejection cools only the failed route, not a sibling model on the same provider', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const primary = { provider: 'opencode-go', id: 'glm-5.3-flash', cost: { input: 1, output: 1 } };
  const sibling = { provider: 'opencode-go', id: 'qwen/qwen3.7-flash', cost: { input: 2, output: 2 } };
  const models = [balanced, primary, sibling];
  const first = harness(models, balanced);
  await boot(first);
  await turn(first);
  assert.equal(first.ctx.models.current(), primary);
  await endInError(first, primary, '401 Invalid API key (code=invalid_api_key)', 401);

  const next = harness(models, balanced);
  await boot(next);
  await turn(next);
  assert.equal(next.ctx.models.current(), sibling);
});

for (const [errorStatus, errorMessage] of [
  [403, '403 Permission denied for this resource'],
  [403, '403 API key is invalid for this resource'],
  [400, '400 Invalid API key field in the request body'],
  [401, '401 Invalid request signature'],
] as const) {
  test(`a request-specific rejection does not blacklist a credential: ${errorMessage}`, async () => {
    const h = harness([virtualFree, primaryFree, secondaryFree], virtualFree);
    await boot(h);
    await turn(h);
    const pick = h.setModelCalls[0];
    await endInError(h, pick, errorMessage, errorStatus);
    const next = harness([virtualFree, primaryFree, secondaryFree], virtualFree);
    await boot(next);
    await turn(next);
    assert.equal(next.ctx.models.current(), pick);
  });
}

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

function stoppedRequest(pick: { provider: string; id: string }, errorMessage = '429 rate limit retry-after-ms=3600000') {
  const last = { role: 'assistant', provider: pick.provider, model: pick.id, stopReason: 'error',
    content: [] as Array<{ type: string; text: string }>, errorMessage };
  return { type: 'session_stop', messages: [last], last_assistant_message: last,
    turn_id: 1, session_id: 's1', stop_hook_active: false, signal: new AbortController().signal };
}

test('a managed request continues on its tier after the concrete native fallback also fails', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const primary = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const native = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const backup = { provider: 'openrouter', id: primary.id, cost: { input: 3, output: 3 } };
  const h = harness([balanced, primary, native, backup], balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), primary);
  h.setCurrent(native);
  await h.emit('retry_fallback_applied', { from: `kilo/${primary.id}:high`, to: `kilo/${native.id}` });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  assert.equal(h.ctx.models.current(), native, 'native recovery must get its own chance first');
  await h.emit('auto_retry_end', { success: false });

  const result = await h.emit('session_stop', stoppedRequest(native));
  assert.equal(h.ctx.models.current(), backup, 'choose a working PMR route before the original request settles');
  assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
  await turn(h);
  assert.equal(h.ctx.models.current(), backup, 'the continuation must stay managed');
});

test('managed recovery also runs when native fallback has no candidate and emits no retry event', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), primaryFree);
  const result = await h.emit('session_stop', stoppedRequest(primaryFree));
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
});

test('managed recovery follows ownership through multiple concrete native fallback hops', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const primary = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const native = { provider: 'kilo', id: 'qwen/qwen3.5-flash', cost: { input: 2, output: 2 } };
  const lastNative = { provider: 'kilo', id: 'qwen/qwen3.0-flash', cost: { input: 3, output: 3 } };
  const h = harness([balanced, primary, native, lastNative, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  for (const [from, to] of [[primary, native], [native, lastNative]]) {
    h.setCurrent(to);
    await h.emit('retry_fallback_applied', { from: `kilo/${from.id}`, to: `kilo/${to.id}` });
    await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  }
  await h.emit('auto_retry_end', { success: false });
  const result = await h.emit('session_stop', stoppedRequest(lastNative));
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
});

test('terminal recovery retains frontier rather than taking a balanced paid-flash fallback', async () => {
  const frontier = { provider: 'pmr', id: 'frontier', cost: {} };
  const primary = { provider: 'kilo', id: 'z-ai/glm-5', cost: { input: 1, output: 1 } };
  const flash = { provider: 'openrouter', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const h = harness([frontier, primary, flash, secondaryFree], frontier);
  await boot(h);
  await turn(h);
  assert.equal(h.ctx.models.current(), primary);
  const result = await h.emit('session_stop', stoppedRequest(primary));
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
});

test('a direct model session is not opted into terminal PMR recovery', async () => {
  const h = harness([primaryFree, secondaryFree], primaryFree);
  await boot(h);
  await turn(h);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
  assert.equal(h.setModelCalls.length, 0);
});

test('manual selection after a native fallback vetoes terminal PMR recovery', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree);
  await h.emit('retry_fallback_applied', { from: `kilo/${primaryFree.id}`, to: `openrouter/${secondaryFree.id}` });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  await h.emit('auto_retry_end', { success: false });
  h.setCurrent(primaryFree);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('terminal recovery cannot revive a manual opt-out by returning to the old router pick', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree);
  await turn(h);
  h.setCurrent(primaryFree);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('an interrupted terminal request is not continued by PMR', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  const controller = new AbortController();
  controller.abort();
  const event = { ...stoppedRequest(primaryFree), signal: controller.signal };
  assert.equal(await h.emit('session_stop', event), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('terminal recovery cannot replay a partial answer or an unclassified request error', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  const partial = stoppedRequest(primaryFree);
  partial.last_assistant_message.content.push({ type: 'text', text: 'A partial answer was already delivered' });
  assert.equal(await h.emit('session_stop', partial), undefined);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree, '400 invalid request body')), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('terminal recovery stops when the tier has no eligible route left', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree], balanced);
  await boot(h);
  await turn(h);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('terminal recovery cannot strand provider-native compacted history', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const codex = { provider: 'openai-codex', id: 'gpt-6-luna', api: 'openai-codex-responses', cost: { input: 1, output: 1 } };
  const models: unknown[] = [balanced, codex];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  models.push(secondaryFree);
  h.ctx.sessionManager.getBranch = () => [{ type: 'compaction', method: 'remote' }];
  assert.equal(await h.emit('session_stop', stoppedRequest(codex)), undefined);
  assert.equal(h.ctx.models.current(), codex);
});

test('terminal recovery does not request continuation when the model switch fails', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setSwitchResult(false);
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
  h.setSwitchResult(true);
  await turn(h);
  assert.equal(h.ctx.models.current(), secondaryFree, 'a failed switch must not silently opt the managed session out');
});

test('a successful concrete native fallback keeps the session managed for the next request', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const primary = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
  const backup = { provider: 'openrouter', id: primary.id, cost: { input: 2, output: 2 } };
  const h = harness([balanced, primary, backup, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree);
  await h.emit('retry_fallback_applied', { from: `kilo/${primary.id}`, to: `openrouter/${secondaryFree.id}` });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  await h.emit('auto_retry_end', { success: true });
  const event = stoppedRequest(secondaryFree);
  event.last_assistant_message.stopReason = 'stop';
  assert.equal(await h.emit('session_stop', event), undefined, 'a successful answer needs no recovery');
  await turn(h);
  assert.equal(h.ctx.models.current(), backup, 'a native fallback must not be mistaken for a manual opt-out');
});

test('PMR does not schedule a second continuation while native retry still owns the request', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const h = harness([balanced, primaryFree, secondaryFree], balanced);
  await boot(h);
  await turn(h);
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
  assert.equal(h.ctx.models.current(), primaryFree);
});

test('an abort during model resolution prevents a managed stop continuation', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const models = [balanced, primaryFree, secondaryFree];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  const controller = new AbortController();
  h.ctx.models.resolve = (selector: string) => {
    controller.abort();
    return models.find(model => `${model.provider}/${model.id}` === selector);
  };
  assert.equal(await h.emit('session_stop', { ...stoppedRequest(primaryFree), signal: controller.signal }), undefined);
});

for (const boundary of ['next request', 'terminal stop', 'new native hop'] as const) {
  test(`a native primary restore retains managed ownership at ${boundary}`, async () => {
    const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
    const primary = { provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } };
    const backup = { provider: 'openrouter', id: primary.id, cost: { input: 2, output: 2 } };
    const h = harness([balanced, primary, backup, primaryFree, secondaryFree], balanced);
    await boot(h);
    await turn(h);
    h.setCurrent(primaryFree);
    await h.emit('retry_fallback_applied', { from: `kilo/${primary.id}`, to: `kilo/${primaryFree.id}` });
    await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
    await h.emit('auto_retry_end', { success: true });
    h.setCurrent(primary, 'fallback'); // OMP restores its primary without a retry_fallback_applied event.
    if (boundary === 'next request') {
      await turn(h);
    } else {
      const failed = boundary === 'terminal stop' ? primary : secondaryFree;
      if (boundary === 'new native hop') {
        h.setCurrent(secondaryFree);
        await h.emit('retry_fallback_applied', { from: `kilo/${primary.id}`, to: `openrouter/${secondaryFree.id}` });
        await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
        await h.emit('auto_retry_end', { success: false });
      }
      const result = await h.emit('session_stop', stoppedRequest(failed));
      assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
    }
    assert.equal(h.ctx.models.current(), backup, 'native restoration must not become a manual opt-out');
  });
}

for (const error of ['401 This API key has expired (param=api_key_expired)', `404 The requested model 'retired-model' does not exist`]) {
  test(`managed terminal recovery handles a non-retried route rejection: ${error}`, async () => {
    const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
    const h = harness([balanced, primaryFree, secondaryFree], balanced);
    await boot(h);
    await turn(h);
    const result = await h.emit('session_stop', stoppedRequest(primaryFree, error));
    assert.equal(h.ctx.models.current(), secondaryFree);
    assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
  });
}

for (const error of ['500 upstream overloaded', 'ECONNRESET connection closed']) {
  test(`an unclassified transient failure does not create a quota-style retry: ${error}`, async () => {
    const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
    const h = harness([balanced, primaryFree, secondaryFree], balanced);
    await boot(h);
    await turn(h);
    assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree, error)), undefined);
    assert.equal(h.ctx.models.current(), primaryFree);
  });
}

test('terminal recovery may switch Responses providers when there is no remote compaction', async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const codex = { provider: 'openai-codex', id: 'gpt-6-luna', api: 'openai-codex-responses', cost: { input: 1, output: 1 } };
  const models: unknown[] = [balanced, codex];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  models.push(secondaryFree);
  const result = await h.emit('session_stop', stoppedRequest(codex));
  assert.equal(h.ctx.models.current(), secondaryFree);
  assert.ok(result && typeof result === 'object' && 'continue' in result && result.continue === true);
});

for (const selection of ['original', 'native descendant'] as const) {
test(`a manual re-selection of the ${selection} remains a manual opt-out`, async () => {
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const models: unknown[] = [balanced, primaryFree, secondaryFree];
  const h = harness(models, balanced);
  await boot(h);
  await turn(h);
  h.setCurrent(secondaryFree);
  await h.emit('retry_fallback_applied', { from: `kilo/${primaryFree.id}`, to: `openrouter/${secondaryFree.id}` });
  await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
  await h.emit('auto_retry_end', { success: true });
  models.push({ provider: 'kilo', id: 'qwen/qwen3.7-flash', cost: { input: 1, output: 1 } });
  const selected = selection === 'original' ? primaryFree : secondaryFree;
  h.setCurrent(selected); // Same selector, but explicitly chosen rather than a native hop/restore.
  assert.equal(await h.emit('session_stop', stoppedRequest(selected)), undefined);
  await turn(h);
  assert.equal(h.ctx.models.current(), selected);
});
}

for (const unavailable of ['empty', 'throws'] as const) {
  test(`native restoration is not assumed when model provenance ${unavailable}`, async () => {
    const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
    const h = harness([balanced, primaryFree, secondaryFree], balanced);
    await boot(h);
    await turn(h);
    h.setCurrent(secondaryFree);
    await h.emit('retry_fallback_applied', { from: `kilo/${primaryFree.id}`, to: `openrouter/${secondaryFree.id}` });
    await h.emit('auto_retry_start', { errorMessage: '429 rate limit', delayMs: 0 });
    await h.emit('auto_retry_end', { success: false });
    h.setCurrent(primaryFree, 'fallback');
    h.ctx.sessionManager.getBranch = () => {
      if (unavailable === 'throws') throw new Error('branch unavailable');
      return [];
    };
    assert.equal(await h.emit('session_stop', stoppedRequest(primaryFree)), undefined);
    assert.equal(h.ctx.models.current(), primaryFree);
  });
}
