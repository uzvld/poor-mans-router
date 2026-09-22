import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adaptiveRouter from '../index.ts';

// A developer's own routing state must not decide a unit test: `state.json` is per-machine
// runtime state, so the store is pointed at a scratch file (AGENTS.md: tests never read state.json).
const SCRATCH_STATE = join(tmpdir(), `pmr-test-state-managed-${process.pid}.json`);
rmSync(SCRATCH_STATE, { force: true });

// Same harness shape as tests/switch-marker.test.ts. Telemetry is empty (pi.exec
// yields nothing) so the ladder's stable pick for a sonnet+free-kilo registry is:
// sonnet -> kilo free (forced switch), kilo -> kilo (no switch).
function harness(models: unknown[], currentModel: unknown) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: Array<{ provider?: string; id?: string }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const providerCalls: Array<{ name: string; sourceId: string }> = [];
  let current = currentModel;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider(name: string, _config: unknown, sourceId: string) {
      providerCalls.push({ name, sourceId });
    },
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
  // The store resolves its path when the extension is constructed; the harness owns that path
  // so the suite never reads the developer's own state.json (AGENTS.md).
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls, notifications, providerCalls, setCurrent: (m: unknown) => { current = m; } };
}

const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 2, output: 10 } };
const kiloFree = { provider: 'kilo', id: 'deepseek/deepseek-v4-flash-0731:free', cost: { input: 0, output: 0 } };
const virtualBalanced = { provider: 'pmr', id: 'balanced', cost: { input: 0, output: 0 } };

async function startSession(h: ReturnType<typeof harness>): Promise<void> {
  for (const h2 of h.handlers.get('session_start')!) await h2({}, h.ctx);
}

async function turn(h: ReturnType<typeof harness>): Promise<void> {
  for (const h2 of h.handlers.get('before_agent_start')!) await h2({}, h.ctx);
}

test('a session on a concrete model is manual: no registration-time routing, no switch, ever', async () => {
  const h = harness([sonnet, kiloFree], sonnet);
  await startSession(h);
  await turn(h);
  await turn(h); // second turn proves "never again", not just "not this turn"
  assert.deepEqual(h.setModelCalls, []);
});

test('cold start on pmr/balanced switches to the ladder winner before first work', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h);
  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0].id, kiloFree.id);
  const marker = h.notifications.find((n) => n.text.startsWith('[omp:pmr] '));
  assert.ok(marker, 'expected an [omp:pmr] marker for the bootstrap switch');
});

test('after a router switch the next turn stays managed (affinity through lastRouterSelected)', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h); // pmr/balanced -> kilo free, lastRouterSelected = kilo key
  assert.equal(h.setModelCalls.length, 1);
  await turn(h); // current == lastRouterSelected -> stay put
  assert.equal(h.setModelCalls.length, 1);
});

test('a manual /model change mid-session flips to manual and stops routing', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h);
  assert.equal(h.setModelCalls.length, 1);
  h.setCurrent(sonnet); // user picked a concrete model the router did not select
  await turn(h);
  assert.equal(h.setModelCalls.length, 1, 'manual switch must not trigger a counter-switch');
  await turn(h);
  assert.equal(h.setModelCalls.length, 1, 'manual mode is sticky');
});

test('a failed router switch does not poison the state machine', async () => {
  // pi.setModel returns false: the switch failed. lastRouterSelected must stay unset
  // so the next turn re-enters managed mode and retries the switch instead of
  // misreading the virtual model as a manual override.
  let calls = 0;
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { calls += 1; return false; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const current = { provider: 'pmr', id: 'balanced', cost: {} };
  const models = [sonnet, kiloFree, current];
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
  adaptiveRouter(pi);
  for (const f of handlers.get('session_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  assert.equal(calls, 2, 'failed switch must be retried next turn (mode not latched, lastRouterSelected unset)');
});

test('manual mode skips telemetry work entirely (no exec calls in manual turns)', async () => {
  let execCalls = 0;
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { execCalls += 1; return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const current = { provider: 'anthropic', id: 'claude-sonnet-5', cost: {} };
  const ctx: any = {
    models: { list: () => [current], current: () => current, resolve: () => undefined },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  adaptiveRouter(pi);
  for (const f of handlers.get('session_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  assert.equal(execCalls, 0, 'manual session must not poll telemetry');
});
