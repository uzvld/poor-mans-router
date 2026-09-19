import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import adaptiveRouter from '../index.ts';

// Live incident, 2026-09-19 ~13:38: Multica agent "Jared" (multica -> hermes -> omp,
// pmr/free) repeated the identical `[omp:pmr] pmr/free -> kilo/arcee-ai/trinity-large-preview:free`
// switch marker across (per live log/session evidence) 4 separate fresh OMP processes, with
// zero real assistant text ever produced. Root cause chain, all confirmed against the live
// install (~/.omp/agent/extensions/adaptive-router/state.json + ~/.omp/logs/omp.2026-09-19.*.log):
//
//   1. Kilo's gateway hard-404s the model: "The requested model
//      'arcee-ai/trinity-large-preview:free' does not exist." -- a permanent catalog-drift
//      error, not a transient rate/quota condition.
//   2. `auto_retry_start` classifies it via `isRateOrQuotaError`, which only matches
//      429/rate-limit/quota wording -- a 404 "does not exist" message is NOT rate/quota, so
//      `retryRoutingPolicy` returns `markRouteCooldown: false` (runtime.ts:90-92) and the
//      handler falls through to `state.recordFailure(routeKey)` only.
//   3. `recordFailure` writes `lastFailureAt` but never `cooldownUntil`; `evaluateRouteHealth`
//      (health.ts) only demotes a route to COOLDOWN when `cooldownUntil` is set -- so the
//      route stays AVAILABLE forever. Confirmed live: the route has NO entry at all in
//      `state.json`'s `routes` map despite a logged 404 at 13:38:08.
//   4. Multica spawns a fresh OMP process per run (index.ts:128-129 comment). Every fresh
//      process re-reads the same on-disk state, re-derives the identical "best-free" winner
//      from the same unpenalized inputs, and repeats the cycle: announce the marker, hit the
//      same 404, produce zero text, exit -- forever, invisibly (no cooldown, no answer, no
//      user-visible error beyond the bare marker line the Hermes bridge happens to surface).
//
// This test reproduces step 2-4 purely in-repo: two independent `adaptiveRouter(pi)`
// instances (= two independent processes) share the same on-disk state.json, exactly like
// two Multica-spawned OMP runs. A hard "model does not exist" error between them must cool
// the failed route down so the second process's ladder picks a different candidate --
// currently it does not.

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state.json');

function harness(models: unknown[], currentModel: unknown) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: Array<{ provider?: string; id?: string }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
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
    ui: { notify(text: string, level = 'info') { notifications.push({ text, level }); } },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls, notifications };
}

async function boot(h: ReturnType<typeof harness>): Promise<void> {
  for (const f of h.handlers.get('session_start')!) await f({}, h.ctx);
}

async function turn(h: ReturnType<typeof harness>): Promise<void> {
  for (const f of h.handlers.get('before_agent_start')!) await f({}, h.ctx);
}

const virtualFree = { provider: 'pmr', id: 'free', cost: {} };
// Two free candidates in the same policy classes (both non-chinese, non-flash free ids ->
// {best-free, healthy-free, healthy-free-fast}), so a cooldown on whichever wins first must
// fall through to the other.
const primaryFree = { provider: 'kilo', id: 'arcee-ai/trinity-large-preview:free', cost: { input: 0, output: 0 } };
const secondaryFree = { provider: 'openrouter', id: 'nvidia/nemotron:free', cost: { input: 0, output: 0 } };

test.beforeEach(() => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ routes: {} }));
});

test('a hard "model does not exist" retry error cools the route down so a fresh process picks a different one', async () => {
  const models = [virtualFree, primaryFree, secondaryFree];

  // Process 1 (first Multica-spawned OMP run): bootstrap into managed mode and switch.
  const h1 = harness(models, virtualFree);
  await boot(h1);
  await turn(h1);
  assert.equal(h1.setModelCalls.length, 1, 'precondition: process 1 switched once');
  const firstPick = h1.setModelCalls[0];

  // Kilo's gateway 404s the model OMP just tried -- a permanent catalog-drift error, not
  // rate/quota. This is what the live log showed at 13:38:08.
  for (const f of h1.handlers.get('auto_retry_start')!) {
    await f({
      errorMessage: `404 The requested model '${firstPick.id}' does not exist. Please use an exact model id as listed on /api/gateway/models.`,
    }, h1.ctx);
  }
  for (const f of h1.handlers.get('auto_retry_end')!) await f({}, h1.ctx);

  // Process 2 (a fresh Multica-spawned OMP run, same on-disk state.json): must not repeat
  // the identical broken pick.
  const h2 = harness(models, virtualFree);
  await boot(h2);
  await turn(h2);
  assert.equal(h2.setModelCalls.length, 1, 'process 2 must also switch (it starts on the virtual model again)');
  assert.notEqual(
    h2.setModelCalls[0].id,
    firstPick.id,
    `process 2 re-selected the exact route that just hard-404d (${firstPick.id}) -- the failure was never recorded as a cooldown, so every fresh process repeats the identical broken switch forever`,
  );
});
