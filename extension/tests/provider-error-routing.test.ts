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

function harness(initial = virtual, models = [virtual, primary, backup], sharedState?: string, authStorage?: unknown) {
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
    setTimeout() {}, setInterval() {}, modelRegistry: { getApiKeyForProvider: async () => undefined, authStorage }, ui: { notify() {} },
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

/** The slice of the test harness the expired-key scenario drives. */
interface ExpiredKeyDriver {
  boot(): Promise<void>;
  setCurrent(model: Model): void;
  emit(name: string, event?: unknown): Promise<void>;
}

// OMP v18.12.3 AuthStorage surface PMR reads: credentials.list/generation, keys.source,
// blocks.list (scope 'auth') and health.model. Row ids and states only; never a key.
type CredentialKind = 'api_key' | 'oauth';

function authPool(kind: CredentialKind, ...ids: number[]) {
  const until = Date.now() + 60_000;
  const rows = (ids.length ? ids : [11]).map(id => ({
    id, provider: 'alpha', disabledCause: null as string | null,
    credential: kind === 'api_key' ? { type: kind, source: 'login' as string | undefined, key: 'synthetic' } : { type: kind, access: 'synthetic' },
  }));
  const blocked = new Set<number>(rows.map(row => row.id));
  const storage = {
    credentials: { generation: 1, list: (provider: string) => provider === 'alpha' ? rows : [] },
    keys: { source: (provider: string): { kind: string } | undefined => provider === 'alpha' ? { kind } : undefined },
    blocks: {
      list: (credentialIds: number[]): Array<{ credentialId: number; providerKey: string; blockScope: string; blockedUntilMs: number }> =>
        credentialIds.filter(id => blocked.has(id))
          .map(credentialId => ({ credentialId, providerKey: `alpha:${kind}`, blockScope: 'auth', blockedUntilMs: until })),
    },
    health: {
      // OMP aggregates only the pool of the active key source, one account entry per credential.
      model: async (provider: string): Promise<{ state: string; accounts: Array<{ credentialId: number; credentialType: string; state: string }> }> => {
        const accounts = provider === 'alpha' ? rows.filter(row => row.credential.type === kind && (kind !== 'api_key' || row.credential.source === 'login'))
          .map(row => ({ credentialId: row.id, credentialType: kind, state: blocked.has(row.id) ? 'depleted' : 'healthy' })) : [];
        return { state: accounts.length && accounts.every(account => account.state === 'depleted') ? 'depleted' : 'healthy', accounts };
      },
    },
  };
  return { storage, blocked, rows };
}
const sibling: Model = { ...primary, id: 'claude-sonnet-4-5' };

async function expiredKeyFallback(h: ExpiredKeyDriver) {
  await h.boot();
  h.setCurrent(virtual);
  await h.emit('retry_fallback_applied', { from: `${primary.provider}/${primary.id}`, to: 'pmr/balanced' });
  await h.emit('auto_retry_start', { errorMessage: '401 This API key has expired. Create a new API key.', delayMs: 0 });
}

test('when OMP reports every credential of the provider auth-blocked, sibling models are excluded too, in every process', async () => {
  const models = [virtual, primary, sibling, backup];
  const h = harness(virtual, models, undefined, authPool('api_key').storage);
  try {
    await expiredKeyFallback(h);
    assert.equal(h.ctx.models.current(), backup, 'the same dead key cannot serve a sibling model of that provider');
    assert.ok(h.state().routes['alpha/claude-sonnet-4-5'].cooldownUntil > Date.now(), 'the veto is persisted for fresh processes');
    const fresh = harness(virtual, models, h.stateFile, authPool('api_key').storage);
    try { await fresh.boot(); assert.equal(fresh.ctx.models.current(), backup); }
    finally { fresh.close(); }
  } finally { h.close(); }
});

test('a provider with another usable credential only loses the failed route', async () => {
  const pool = authPool('api_key', 11, 12);
  pool.blocked.delete(12);
  const h = harness(virtual, [virtual, primary, sibling, backup], undefined, pool.storage);
  try {
    await expiredKeyFallback(h);
    assert.equal(h.ctx.models.current(), sibling, 'OMP can rotate to the unblocked credential for the sibling model');
    assert.equal(h.state().routes['alpha/claude-sonnet-4-5']?.cooldownUntil, undefined);
  } finally { h.close(); }
});

test('an incomplete or unreadable credential pool never widens the veto beyond the failed route', async () => {
  const incomplete = authPool('api_key', 11, 12);
  incomplete.storage.health.model = async () => ({ state: 'depleted', accounts: [{ credentialId: 11, credentialType: 'api_key', state: 'depleted' }] });
  const unreadable = authPool('api_key');
  unreadable.storage.blocks.list = () => { throw new Error('store unavailable'); };
  for (const storage of [incomplete.storage, unreadable.storage, undefined]) {
    const h = harness(virtual, [virtual, primary, sibling, backup], undefined, storage);
    try {
      await expiredKeyFallback(h);
      assert.equal(h.ctx.models.current(), sibling);
      assert.ok(h.state().routes['alpha/claude-sonnet-4-6'].cooldownUntil > Date.now(), 'the failed route keeps its own cooldown');
    } finally { h.close(); }
  }
});

test('a terminal credential rejection also widens the veto only on complete OMP evidence', async () => {
  const models = [virtual, primary, sibling, backup];
  const h = harness(virtual, models, undefined, authPool('api_key').storage);
  try {
    await h.boot();
    await h.emit('agent_end', { messages: [h.error({ errorMessage: '401 This API key has expired.', content: [] })] });
    await h.emit('before_agent_start');
    assert.equal(h.ctx.models.current(), backup);
  } finally { h.close(); }
});

test('a transport failure never widens the veto to sibling models, even when the credential pool is blocked', async () => {
  const h = harness(virtual, [virtual, primary, sibling, backup], undefined, authPool('api_key').storage);
  try {
    await h.boot();
    h.setCurrent(virtual);
    await h.emit('retry_fallback_applied', { from: `${primary.provider}/${primary.id}`, to: 'pmr/balanced' });
    await h.emit('auto_retry_start', { errorMessage: 'fetch failed: ECONNRESET', delayMs: 0 });
    assert.equal(h.ctx.models.current(), sibling);
    assert.equal(h.state().routes['alpha/claude-sonnet-4-5']?.cooldownUntil, undefined);
  } finally { h.close(); }
});

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

/** Runs the expired-key fallback against `storage` and reports whether the sibling model got a veto. */
async function siblingIsCooled(storage: unknown): Promise<boolean> {
  const h = harness(virtual, [virtual, primary, sibling, backup], undefined, storage);
  try {
    await expiredKeyFallback(h);
    return (h.state().routes['alpha/claude-sonnet-4-5']?.cooldownUntil ?? 0) > Date.now();
  } finally { h.close(); }
}

// Each case breaks exactly one of the facts that together prove "no credential can serve this provider".
// Widening on any of them could cool a provider that still has a usable key, so each must stay failed-route-only.
const INCONCLUSIVE_POOLS: Array<{ name: string; build: () => unknown }> = [
  { name: 'a usage (non-auth) block on every credential', build: () => {
    const p = authPool('api_key'); const list = p.storage.blocks.list;
    p.storage.blocks.list = ids => list(ids).map(block => ({ ...block, blockScope: 'tier:fable' })); return p.storage; } },
  { name: 'an expired auth block', build: () => {
    const p = authPool('api_key'); const list = p.storage.blocks.list;
    p.storage.blocks.list = ids => list(ids).map(block => ({ ...block, blockedUntilMs: Date.now() - 1 })); return p.storage; } },
  { name: 'a block recorded for another credential kind', build: () => {
    const p = authPool('api_key'); const list = p.storage.blocks.list;
    p.storage.blocks.list = ids => list(ids).map(block => ({ ...block, providerKey: 'alpha:oauth' })); return p.storage; } },
  { name: 'OMP reporting the pool healthy while every block is live', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'healthy', accounts: [{ credentialId: 11, credentialType: 'api_key', state: 'healthy' }] }); return p.storage; } },
  { name: 'OMP reporting the pool inside its reserve', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'reserve', accounts: [{ credentialId: 11, credentialType: 'api_key', state: 'reserve' }] }); return p.storage; } },
  { name: 'an account state that contradicts the pool state', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'depleted', accounts: [{ credentialId: 11, credentialType: 'api_key', state: 'healthy' }] }); return p.storage; } },
  { name: 'an account of the wrong credential kind', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'depleted', accounts: [{ credentialId: 11, credentialType: 'oauth', state: 'depleted' }] }); return p.storage; } },
  { name: 'an aggregate pool state other than depleted', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'unknown', accounts: [{ credentialId: 11, credentialType: 'api_key', state: 'depleted' }] }); return p.storage; } },
  { name: 'OMP listing accounts that are not in the pool PMR read', build: () => {
    const p = authPool('api_key');
    p.storage.health.model = async () => ({ state: 'depleted', accounts: [
      { credentialId: 11, credentialType: 'api_key', state: 'depleted' }, { credentialId: 99, credentialType: 'api_key', state: 'depleted' }] }); return p.storage; } },
  { name: 'a pool that changed while health was being read', build: () => {
    const p = authPool('api_key'); const model = p.storage.health.model;
    p.storage.health.model = async provider => { p.storage.credentials.generation++; return model(provider); }; return p.storage; } },
  { name: 'a key source that changed while health was being read', build: () => {
    const p = authPool('api_key'); const model = p.storage.health.model;
    p.storage.health.model = async provider => { p.storage.keys.source = () => ({ kind: 'env' }); return model(provider); }; return p.storage; } },
  { name: 'a disabled credential row', build: () => {
    const p = authPool('api_key'); p.rows[0]!.disabledCause = 'deleted by user'; return p.storage; } },
  { name: 'duplicate credential ids', build: () => {
    const p = authPool('api_key', 11, 11); return p.storage; } },
  { name: 'a key source that is not an OMP-managed pool', build: () => {
    const p = authPool('api_key'); p.storage.keys.source = () => ({ kind: 'env' }); return p.storage; } },
  { name: 'OAuth accounts next to a login API key', build: () => {
    const p = authPool('api_key');
    p.rows.push({ id: 13, provider: 'alpha', disabledCause: null, credential: { type: 'oauth', access: 'synthetic' } } as never); return p.storage; } },
];

for (const { name, build } of INCONCLUSIVE_POOLS) {
  test(`the veto is not widened on ${name}`, async () => {
    assert.equal(await siblingIsCooled(build()), false);
  });
}

// Real timer on purpose: the 250 ms bound is production behaviour of authBlockedUntil, and a
// fake clock cannot make AbortSignal.timeout fire. The pending promise is what a hung OMP looks like.
test('the veto is not widened when OMP does not answer in time', async () => {
  const p = authPool('api_key');
  p.storage.health.model = () => Promise.withResolvers<{ state: string; accounts: [] }>().promise;
  assert.equal(await siblingIsCooled(p.storage), false);
});

test('an OAuth account pool that OMP reports fully blocked widens the veto too', async () => {
  assert.equal(await siblingIsCooled(authPool('oauth').storage), true);
});

test('only login-stored API keys form the pool: another stored key does not hold the veto back', async () => {
  const p = authPool('api_key', 11, 12);
  p.blocked.delete(12);
  p.rows[1]!.credential.source = undefined;
  assert.equal(await siblingIsCooled(p.storage), true);
});
