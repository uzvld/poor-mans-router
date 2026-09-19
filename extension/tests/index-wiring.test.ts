import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

test('extension registers lifecycle hooks and route-status without doing runtime work at load time', () => {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  let label = '';
  const pi: any = {
    setLabel(value: string) { label = value; },
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, config: any) { commands.set(name, config); },
    registerProvider(_name: string, _config: unknown, _sourceId: string) { /* recorded via providerRegistrations below when needed */ },
    exec() { throw new Error('exec must not run at extension load time'); },
    setModel() { throw new Error('setModel must not run at extension load time'); },
    logger: { info() {}, warn() {}, debug() {} },
  };

  adaptiveRouter(pi);
  assert.equal(label, 'Adaptive Model Router');
  assert.ok(handlers.has('session_start'));
  assert.ok(handlers.has('before_agent_start'));
  assert.ok(handlers.has('auto_retry_start'));
  assert.ok(handlers.has('auto_retry_end'));
  assert.ok(handlers.has('retry_fallback_applied'));
  assert.ok(handlers.has('agent_end'));
  assert.ok(commands.has('route-status'));
});
