import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

// A router-initiated model switch must be visible in the session output the way tool
// calls are: an `[omp:router] <from> -> <to> (<reason>)` line. OMP delivers
// `ctx.ui.notify()` to the host as `extension_ui_request{method:"notify"}`, which the
// Hermes OMP plugin renders verbatim when the message starts with `[omp:`.
function harness(models: any[], currentModel: any) {
  const handlers = new Map<string, Function[]>();
  const setModelCalls: any[] = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const pi: any = {
    setLabel() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: any) { setModelCalls.push(m); return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => currentModel,
      resolve: (selector: string) => models.find((m) => `${m.provider}/${m.id}` === selector),
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

const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 2, output: 10 } };
const kiloFree = { provider: 'kilo', id: 'deepseek/deepseek-v4-flash-0731:free', cost: { input: 0, output: 0 } };
const balanced = { provider: 'router', id: 'balanced', cost: { input: 0, output: 0 } };

test('router-initiated switch emits an [omp:router] from -> to marker with the reason', async () => {
  // No telemetry (pi.exec yields nothing): sonnet has no live quota evidence, so the
  // ladder prefers the free kilo route. Starting on router/balanced enters managed
  // mode and the bootstrap switch to kilo must be announced.
  const { handlers, ctx, setModelCalls, notifications } = harness([sonnet, kiloFree, balanced], balanced);
  for (const h of handlers.get('session_start')!) await h({}, ctx);
  for (const h of handlers.get('before_agent_start')!) await h({}, ctx);

  assert.equal(setModelCalls.length, 1, 'precondition: the router switched exactly once');
  assert.equal(setModelCalls[0].id, kiloFree.id);
  const marker = notifications.find((n) => n.text.startsWith('[omp:router] '));
  assert.ok(marker, `expected an [omp:router] notification, got ${JSON.stringify(notifications)}`);
  assert.match(marker!.text, /^\[omp:router\] router\/balanced -> kilo\/deepseek\/deepseek-v4-flash-0731:free \(.+\)$/);
});

test('no switch means no marker', async () => {
  // Already on the route the ladder would pick (kilo free, entered via router/balanced
  // opt-in and the router's own switch): nothing to switch, nothing to announce.
  const { handlers, ctx, setModelCalls, notifications } = harness([sonnet, kiloFree, balanced], kiloFree);
  for (const h of handlers.get('session_start')!) await h({}, ctx);
  for (const h of handlers.get('before_agent_start')!) await h({}, ctx);
  assert.deepEqual(setModelCalls, []);
  assert.deepEqual(notifications.filter((n) => n.text.startsWith('[omp:')), []);
});

