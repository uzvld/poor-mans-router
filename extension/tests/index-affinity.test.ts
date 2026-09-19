import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

// End-to-end through the real before_agent_start handler with a fake pi/ctx:
// the session's CURRENT model must reach the selector as the affinity key, so an
// equal same-family sibling does not trigger a gratuitous setModel().
function harness(models: any[], currentModel: any) {
  const handlers = new Map<string, Function[]>();
  const setModelCalls: any[] = [];
  const pi: any = {
    setLabel() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    registerProvider() {},
    // Telemetry is fetched via pi.exec; return "nothing" so routes fall to the no-telemetry path.
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: any) { setModelCalls.push(m); return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  let current = currentModel;
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout(fn: Function) { /* do not run background refreshers in the test */ },
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls, setCurrent: (m: any) => { current = m; } };
}

const sonnet = (id: string) => ({ provider: 'anthropic', id, cost: { input: 2, output: 10 } });

test('before_agent_start keeps the current same-family model instead of switching to an equal sibling', async () => {
  // I8: affinity is a tie-break only, and it applies to the model the session is
  // actually on. Turn 1 opts in via pmr/balanced with only the OLDER sibling
  // available, so the router lands there and owns the selection. The newer, equal
  // sibling then appears in the registry: without affinity wiring the generation
  // tie-break picks claude-sonnet-5 and forces a needless setModel(); with it we
  // stay put.
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const older = sonnet('claude-sonnet-4-6');
  const models = [balanced, older];
  const { handlers, ctx, setModelCalls, setCurrent } = harness(models, balanced);
  for (const h of handlers.get('session_start')!) await h({}, ctx);
  for (const h of handlers.get('before_agent_start')!) await h({}, ctx);
  assert.equal(setModelCalls.length, 1, 'precondition: the router bootstrapped into managed mode');
  assert.equal(setModelCalls[0].id, 'claude-sonnet-4-6');

  // The router's own pick is now current (managed mode persists), and an equal
  // newer sibling joins the registry.
  setCurrent(older);
  models.push(sonnet('claude-sonnet-5'));
  for (const h of handlers.get('before_agent_start')!) await h({}, ctx);
  assert.equal(setModelCalls.length, 1, `expected no switch away from current model, got ${JSON.stringify(setModelCalls.map((m) => m.id))}`);
});
