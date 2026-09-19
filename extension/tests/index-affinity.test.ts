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
    // Telemetry is fetched via pi.exec; return "nothing" so routes fall to the no-telemetry path.
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
    setTimeout(fn: Function) { /* do not run background refreshers in the test */ },
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls };
}

const sonnet = (id: string) => ({ provider: 'anthropic', id, cost: { input: 2, output: 10 } });

test('before_agent_start keeps the current same-family model instead of switching to an equal sibling', async () => {
  // Current = the OLDER sibling. Without affinity wiring, the generation tie-break
  // picks claude-sonnet-5 and forces a needless setModel(); with it, we stay put.
  const models = [sonnet('claude-sonnet-4-6'), sonnet('claude-sonnet-5')];
  const { handlers, ctx, setModelCalls } = harness(models, sonnet('claude-sonnet-4-6'));
  for (const h of handlers.get('session_start')!) await h({}, ctx);
  for (const h of handlers.get('before_agent_start')!) await h({}, ctx);
  assert.deepEqual(setModelCalls, [], `expected no switch away from current model, got ${JSON.stringify(setModelCalls.map((m) => m.id))}`);
});
