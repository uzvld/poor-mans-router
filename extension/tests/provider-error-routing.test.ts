import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adaptiveRouter from '../index.ts';

type Model = { provider: string; id: string; cost: { input?: number; output?: number } };
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
const virtual: Model = { provider: 'pmr', id: 'balanced', cost: {} };
const primary: Model = { provider: 'alpha', id: 'claude-sonnet-4-6', cost: { input: 1, output: 1 } };
const backup: Model = { ...primary, provider: 'beta', cost: { input: 2, output: 2 } };
const streamError = 'Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)';
const retirement = 'Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.';

function harness(initial = virtual, models = [virtual, primary, backup], sharedState?: string) {
  const work = sharedState ? undefined : mkdtempSync(join(tmpdir(), 'pmr-error-routing-'));
  const stateFile = sharedState ?? join(work!, 'state.json');
  const previous = process.env.PMR_STATE_FILE;
  process.env.PMR_STATE_FILE = stateFile;
  let current = initial;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    setLabel() {}, registerProvider() {}, registerCommand() {},
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(model: Model) { current = model; return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx = {
    models: { list: () => models, current: () => current, resolve: (selector: string) => models.find(model => `${model.provider}/${model.id}` === selector) },
    sessionManager: { getBranch: () => [], getSessionId: () => 'isolated' },
    setTimeout() {}, setInterval() {}, modelRegistry: { getApiKeyForProvider: async () => undefined }, ui: { notify() {} },
  };
  // The host has unrelated APIs; this double implements only the external boundary PMR consumes.
  adaptiveRouter(pi as unknown as Parameters<typeof adaptiveRouter>[0]);
  return {
    ctx, stateFile,
    async emit(name: string, event: unknown = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); },
    error(overrides: Record<string, unknown> = {}) {
      return { role: 'assistant', provider: primary.provider, model: primary.id, stopReason: 'error', errorMessage: streamError, content: [{ type: 'text', text: retirement }], ...overrides };
    },
    async boot() { for (const name of ['session_start', 'before_agent_start']) for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
    setCurrent(model: Model) { current = model; },
    state() { return JSON.parse(readFileSync(stateFile, 'utf8')); },
    close() { if (previous === undefined) delete process.env.PMR_STATE_FILE; else process.env.PMR_STATE_FILE = previous; if (work) rmSync(work, { recursive: true, force: true }); },
  };
}

test('a retired-model partial error stays terminal but excludes the failed route on the next turn and fresh process', async () => {
  const h = harness();
  try {
    await h.boot();
    assert.equal(h.ctx.models.current(), primary);
    await h.emit('agent_end', { messages: [h.error()] });
    assert.equal(h.ctx.models.current(), primary, 'PMR must not initiate a new model switch at terminal settle');
    assert.ok(h.state().routes['alpha/claude-sonnet-4-6'].cooldownUntil > Date.now() + 60 * 60_000);
    await h.emit('before_agent_start');
    assert.equal(h.ctx.models.current(), backup);
    const fresh = harness(virtual, [virtual, primary, backup], h.stateFile);
    try { await fresh.boot(); assert.equal(fresh.ctx.models.current(), backup); }
    finally { fresh.close(); }
  } finally { h.close(); }
});

test('semantic unavailable errors cannot reselect the failed route through a virtual native fallback', async () => {
  const h = harness();
  try {
    await h.boot();
    h.setCurrent(virtual);
    await h.emit('retry_fallback_applied', { from: `${primary.provider}/${primary.id}`, to: 'pmr/balanced' });
    await h.emit('auto_retry_start', { errorMessage: '400 Upstream request failed: Model is unavailable.', delayMs: 0 });
    assert.equal(h.ctx.models.current(), backup);
    await h.emit('auto_retry_end');
    await h.emit('before_agent_start');
    assert.equal(h.ctx.models.current(), backup);
  } finally { h.close(); }
});

test('expired credentials exclude the failed route before native virtual fallback chooses again', async () => {
  const h = harness();
  try {
    await h.boot();
    h.setCurrent(virtual);
    await h.emit('retry_fallback_applied', { from: `${primary.provider}/${primary.id}`, to: 'pmr/balanced' });
    await h.emit('auto_retry_start', { errorMessage: '401 This API key has expired. Create a new API key.', delayMs: 0 });
    assert.equal(h.ctx.models.current(), backup);
  } finally { h.close(); }
});

test('error bookkeeping applies to the failed provider rather than an intervening manual selection', async () => {
  const h = harness();
  try {
    await h.boot();
    h.setCurrent(backup);
    await h.emit('agent_end', { messages: [h.error()] });
    assert.equal(h.ctx.models.current(), backup);
    assert.ok(h.state().routes['alpha/claude-sonnet-4-6'].cooldownUntil > Date.now());
    assert.equal(h.state().routes['beta/claude-sonnet-4-6']?.cooldownUntil, undefined);
  } finally { h.close(); }
});

test('control-plane errors without an actual assistant result do not alter the selected route health', async () => {
  const h = harness();
  try {
    await h.boot();
    await h.emit('agent_end', { messages: [{ type: 'model_usage', provider: 'openrouter', model: '~typesafe/jev-latest', purpose: 'auto-thinking', stopReason: 'error', errorMessage: '402 Insufficient credits' }] });
    assert.equal(h.ctx.models.current(), primary);
    assert.equal(h.state().routes['alpha/claude-sonnet-4-6'], undefined);
  } finally { h.close(); }
});

test('ordinary successful prose about a retired model never creates a failure veto', async () => {
  const h = harness();
  try {
    await h.boot();
    await h.emit('agent_end', { messages: [h.error({ stopReason: 'stop' })] });
    assert.equal(h.state().routes['alpha/claude-sonnet-4-6']?.cooldownUntil, undefined);
    await h.emit('before_agent_start');
    assert.equal(h.ctx.models.current(), primary);
  } finally { h.close(); }
});
