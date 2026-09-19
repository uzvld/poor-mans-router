import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_MODELS,
  virtualModeForModelKey,
  registerVirtualRouterProvider,
} from '../virtual-model.ts';
import { DEFAULT_POLICY, normalizePolicy } from '../policy.ts';
import { allowDrainingForTier } from '../runtime.ts';
import { selectForTier, buildRoutes } from '../ranking.ts';
import adaptiveRouter from '../index.ts';

test('the picker shows four pmr selectors', () => {
  assert.equal(VIRTUAL_PROVIDER, 'pmr');
  assert.deepEqual(VIRTUAL_MODELS.map((m) => m.id), ['frontier', 'balanced', 'small', 'free']);
  for (const id of ['frontier', 'balanced', 'small', 'free']) {
    assert.equal(virtualModeForModelKey(`pmr/${id}`), id);
  }
  assert.equal(virtualModeForModelKey('router/balanced'), undefined, 'the old provider name is gone');
});

test('the free tier ladder never contains a paid class', () => {
  const paid = DEFAULT_POLICY.tiers.free.classes.filter((c) => !c.includes('free'));
  assert.deepEqual(paid, [], `free must stay free-only, found ${paid.join(', ')}`);
  // small is unchanged: cheap-and-fast, paid rungs included.
  assert.deepEqual(DEFAULT_POLICY.tiers.small.classes, ['cheap-sub', 'cheap-flash', 'healthy-free-fast']);
  assert.equal(normalizePolicy({}).tiers.free.classes.length > 0, true);
  assert.equal(allowDrainingForTier('free'), true);
});

test('pmr/free never selects a paid route even when a cheaper paid one exists', () => {
  const models = [
    { provider: 'anthropic', id: 'claude-haiku-5', selector: 'anthropic/claude-haiku-5', cost: { input: 0.1, output: 0.4 } },
    { provider: 'openrouter', id: 'z-ai/glm-5.3-flash:free', selector: 'openrouter/z-ai/glm-5.3-flash:free', cost: {} },
  ];
  const routes = buildRoutes(models, {
    ompReports: [], codexbar: [], localState: {}, history: {}, intel: {}, reservePct: 10, now: Date.now(),
  });
  const pick = selectForTier(routes, DEFAULT_POLICY.tiers.free.classes, { allowDraining: true, preference: 'quality' });
  assert.ok(pick, 'a free route must be selectable');
  assert.equal(pick!.route.free, true);
  assert.equal(pick!.route.provider, 'openrouter');
});

test('the switch marker carries the pmr tag', async () => {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const notifications: string[] = [];
  const free = { provider: 'openrouter', id: 'nvidia/nemotron:free', cost: {} };
  const virtual = { provider: 'pmr', id: 'free', cost: {} };
  const models = [virtual, free];
  let current: unknown = virtual;
  const pi: any = {
    setLabel() {},
    on(name: string, h: (e: unknown, c: unknown) => Promise<unknown>) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: unknown) { current = m; return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (s: string) => models.find((m: any) => `${m.provider}/${m.id}` === s),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify(text: string) { notifications.push(text); } },
  };
  adaptiveRouter(pi);
  for (const f of handlers.get('session_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  const marker = notifications.find((n) => n.startsWith('[omp:'));
  assert.ok(marker, `expected a switch marker, got ${JSON.stringify(notifications)}`);
  assert.match(marker!, /^\[omp:pmr\] pmr\/free -> openrouter\/nvidia\/nemotron:free \(.+\)$/);
});

test('provider registration announces itself as pmr with four models', () => {
  const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
  registerVirtualRouterProvider({
    registerProvider(name: string, config: Record<string, unknown>) { calls.push({ name, config }); },
  });
  assert.equal(calls[0].name, 'pmr');
  const models = calls[0].config.models as Array<{ id: string; name: string }>;
  assert.deepEqual(models.map((m) => m.id), ['frontier', 'balanced', 'small', 'free']);
  assert.deepEqual(models.map((m) => m.name), ['PMR: Frontier', 'PMR: Balanced', 'PMR: Small', 'PMR: Free']);
});
