import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import adaptiveRouter from '../index.ts';

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
  return { handlers, ctx, setModelCalls };
}

async function boot(h: ReturnType<typeof harness>): Promise<void> {
  for (const f of h.handlers.get('session_start')!) await f({}, h.ctx);
}

async function turn(h: ReturnType<typeof harness>): Promise<void> {
  for (const f of h.handlers.get('before_agent_start')!) await f({}, h.ctx);
}

// Shape of OMP's `agent_end` extension event: the full message list, last assistant message
// carrying the provider error the way `logProviderTurnError` logs it.
async function endInError(h: ReturnType<typeof harness>, pick: { provider?: string; id?: string }, errorMessage: string): Promise<void> {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage, errorStatus: 404, provider: pick.provider, model: pick.id },
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
