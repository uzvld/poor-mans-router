import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adaptiveRouter from '../index.ts';

// BUG E (docs/investigations/bug-e-midrun-virtual-selection.md): a client re-selects a
// `pmr/*` model while a run is in flight (Paseo's model picker does exactly that). OMP reads
// the model at the top of every loop iteration, so the very next provider request would go to
// the virtual provider and the leak guard aborts the turn. Verified against a real OMP run:
// `setModel` from `turn_start`/`context` is one request too late; from `tool_result`/`turn_end`
// it lands before the next request. The router must resolve the selection there.
const SCRATCH_STATE = join(tmpdir(), `pmr-test-state-midrun-${process.pid}.json`);
rmSync(SCRATCH_STATE, { force: true });

interface FakeModel { provider: string; id: string; cost: { input: number; output: number } }
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function harness(models: FakeModel[], initial: FakeModel, opts: { setModelResult?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: FakeModel[] = [];
  const notifications: Array<{ text: string; level: string }> = [];
  let current = initial;
  let aborted = 0;
  const pi = {
    setLabel() {},
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: FakeModel) {
      setModelCalls.push(m);
      if (opts.setModelResult === false) return false;
      current = m;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify(text: string, level = 'info') { notifications.push({ text, level }); } },
    abort() { aborted += 1; },
  };
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  adaptiveRouter(pi as unknown as Parameters<typeof adaptiveRouter>[0]);
  return {
    ctx,
    setModelCalls,
    notifications,
    current: () => current,
    abortCount: () => aborted,
    setCurrent: (m: FakeModel) => { current = m; },
    async emit(name: string, event: unknown = {}): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

const sonnet: FakeModel = { provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 2, output: 10 } };
const kiloFree: FakeModel = { provider: 'kilo', id: 'deepseek/deepseek-v4-flash-0731:free', cost: { input: 0, output: 0 } };
const virtualBalanced: FakeModel = { provider: 'pmr', id: 'balanced', cost: { input: 0, output: 0 } };
const virtualSmall: FakeModel = { provider: 'pmr', id: 'small', cost: { input: 0, output: 0 } };
const models = [sonnet, kiloFree, virtualBalanced, virtualSmall];

// A managed session that has already done its first routing pass: current is the ladder winner.
async function routedSession(opts: { setModelResult?: boolean } = {}) {
  const h = harness(models, virtualBalanced, opts);
  await h.emit('session_start');
  await h.emit('before_agent_start');
  assert.equal(h.current().provider, 'kilo', 'precondition: the first pass left the virtual model');
  return h;
}

test('a pmr/* selection that lands mid-run is resolved when the next tool result arrives', async () => {
  const h = await routedSession();
  h.setCurrent(virtualBalanced); // the client re-selects pmr/balanced while the turn is running
  await h.emit('tool_result');
  assert.equal(h.current().provider, 'kilo', 'the next provider request must not go to the virtual provider');
  assert.equal(h.setModelCalls.length, 2);
});

test('a pmr/* selection that lands during the last tool of a turn is resolved at turn end', async () => {
  const h = await routedSession();
  h.setCurrent(virtualSmall);
  await h.emit('turn_end');
  assert.equal(h.current().provider, 'kilo');
});

test('the repaired switch is announced like any other router switch', async () => {
  const h = await routedSession();
  h.setCurrent(virtualBalanced);
  await h.emit('tool_result');
  const markers = h.notifications.filter((n) => n.text.startsWith('[omp:pmr] '));
  assert.equal(markers.length, 2, 'one marker for the first pass, one for the repair');
});

test('several tool results from one batch cause a single switch', async () => {
  const h = await routedSession();
  h.setCurrent(virtualBalanced);
  await h.emit('tool_result');
  await h.emit('tool_result');
  await h.emit('tool_result');
  await h.emit('turn_end');
  assert.equal(h.setModelCalls.length, 2, 'first pass + exactly one repair');
});

test('a concrete model chosen by the router is left alone by tool results and turn ends', async () => {
  const h = await routedSession();
  await h.emit('tool_result');
  await h.emit('turn_end');
  assert.equal(h.setModelCalls.length, 1);
});

test('a manual session is never routed mid-run (N1)', async () => {
  const h = harness(models, sonnet);
  await h.emit('session_start');
  await h.emit('before_agent_start');
  await h.emit('tool_result');
  await h.emit('turn_end');
  assert.deepEqual(h.setModelCalls, []);
  assert.equal(h.current(), sonnet);
});

test('when the repair cannot switch, the leak guard is still the backstop (N2)', async () => {
  const h = harness(models, virtualBalanced, { setModelResult: false });
  await h.emit('session_start');
  await h.emit('before_agent_start'); // the first pass cannot switch: the session stays on pmr/balanced
  const attemptsBefore = h.setModelCalls.length;
  await h.emit('tool_result');
  assert.equal(h.setModelCalls.length, attemptsBefore + 1, 'the repair must try');
  await h.emit('before_provider_request', { payload: {} });
  assert.equal(h.abortCount(), 1, 'a request still on pmr/* is aborted locally');
});
