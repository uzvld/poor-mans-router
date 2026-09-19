import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

// The virtual provider's baseUrl is the TCP discard port. If a provider request is
// ever issued while the session still sits on a router/* model, the router failed
// its one job: OMP would spend 10 auto-retries on a connection error. The guard
// aborts the turn instead, with a message that names the cause.
function harness(currentModel: unknown) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const notifications: Array<{ text: string; level: string }> = [];
  let aborted = 0;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: { list: () => [], current: () => currentModel, resolve: () => undefined },
    sessionManager: { getBranch: () => [], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    ui: { notify(text: string, level = 'info') { notifications.push({ text, level }); } },
    abort() { aborted += 1; },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, notifications, abortCount: () => aborted };
}

test('a provider request issued while still on router/* aborts the turn with a loud local error', async () => {
  const h = harness({ provider: 'router', id: 'balanced' });
  const handler = h.handlers.get('before_provider_request')?.[0];
  assert.ok(handler, 'guard handler must be registered');
  const result = await handler({ type: 'before_provider_request', payload: { body: { model: 'balanced', messages: [] } } }, h.ctx);
  assert.equal(result, undefined, 'the guard must not rewrite the payload');
  assert.equal(h.abortCount(), 1, 'ctx.abort() must fire');
  const notice = h.notifications.at(-1);
  assert.match(notice!.text, /adaptive-router: virtual router model leaked/);
  assert.equal(notice!.level, 'error');
});

test('requests for real providers pass through untouched', async () => {
  const h = harness({ provider: 'anthropic', id: 'claude-sonnet-5' });
  const handler = h.handlers.get('before_provider_request')![0];
  const result = await handler(
    { type: 'before_provider_request', payload: { body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] } } },
    h.ctx,
  );
  assert.equal(result, undefined);
  assert.equal(h.abortCount(), 0);
  assert.deepEqual(h.notifications, []);
});

test('a real provider model whose id collides with a virtual tier is not aborted', async () => {
  // Guarding on the payload's bare model id would abort this legitimate request.
  const h = harness({ provider: 'kilo', id: 'balanced' });
  const handler = h.handlers.get('before_provider_request')![0];
  await handler({ type: 'before_provider_request', payload: { body: { model: 'balanced', messages: [] } } }, h.ctx);
  assert.equal(h.abortCount(), 0);
  assert.deepEqual(h.notifications, []);
});

test('a missing ctx.abort does not turn the guard into a crash', async () => {
  const h = harness({ provider: 'router', id: 'small' });
  delete h.ctx.abort;
  const handler = h.handlers.get('before_provider_request')![0];
  await handler({ type: 'before_provider_request', payload: { body: { model: 'small' } } }, h.ctx);
  assert.match(h.notifications.at(-1)!.text, /adaptive-router: virtual router model leaked/);
});
