import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import adaptiveRouter from '../index.ts';
import { buildRoutes, selectForTier, type OmpModelLike } from '../ranking.ts';
import { DEFAULT_POLICY } from '../policy.ts';
import { RUNG_HYSTERESIS, benchmarkPower, computeLadders, orderLadder, type ClassEconomics, type ClassProfile } from '../rungs.ts';
import type { IntelMap } from '../openrouter-intel.ts';
import type { NormalizedRoute } from '../types.ts';

// PROTOTYPE — `docs/investigations/finding-unclassified-model-names.md`.
// Rung order is derived from a benchmark snapshot instead of being written by hand, and the
// shipped ladder stays the fallback. Two invariants shape every test here:
//   I1 — the ladder is still walked in order; recomputing it never lets a lower rung win
//        while a higher one has an AVAILABLE route.
//   I7 — an unmeasured class gains nothing from being unmeasured: it keeps its shipped index.

const NOW = Date.parse('2026-09-22T00:00:00.000Z');

// A developer's own routing state must not decide this harness (state.json is per-machine runtime
// state; AGENTS.md: tests never read it). The store is pointed at a scratch file.
const SCRATCH_STATE = join(tmpdir(), `pmr-test-state-rungs-${process.pid}.json`);
rmSync(SCRATCH_STATE, { force: true });

// Two frontier subscription rungs. The shipped policy puts `astra-sub` (rung 2) above
// `opus-sub` (rung 3); only the snapshot differs between the tests below.
const ASTRA = { provider: 'openai-codex', id: 'gpt-6-astra', cost: { input: 10, output: 50 } };
const OPUS = { provider: 'anthropic', id: 'claude-opus-5', cost: { input: 5, output: 25 } };

// Measured 2026-09-22 (Artificial Analysis): astra 76.9/51.0, opus-5 78.0/56.5.
const SNAPSHOT: IntelMap = {
  'openai/gpt-6-astra': { coding: 0.769, agentic: 0.51 },
  'anthropic/claude-opus-5': { coding: 0.78, agentic: 0.565 },
};

function usagePayload(providers: string[], remainingFraction: number): string {
  return JSON.stringify({
    generatedAt: NOW,
    reports: providers.map((provider) => ({
      provider,
      fetchedAt: NOW,
      limits: [{
        scope: { windowId: '7d', shared: true },
        amount: { remainingFraction, usedFraction: 1 - remainingFraction },
        window: { resetsAt: NOW + 3_600_000 },
        status: 'ok',
      }],
    })),
  });
}

const HEALTHY = [{ provider: 'openai-codex', credentialKey: 'openai-codex#1', fetchedAt: NOW, windows: [{ id: '7d', shared: true, remainingFraction: 1, resetsAt: NOW + 3_600_000, status: 'ok' }] },
  { provider: 'anthropic', credentialKey: 'anthropic#1', fetchedAt: NOW, windows: [{ id: '7d', shared: true, remainingFraction: 1, resetsAt: NOW + 3_600_000, status: 'ok' }] }];

function frontierRoutes(intel: IntelMap, ompReports = HEALTHY): NormalizedRoute[] {
  return buildRoutes([ASTRA, OPUS] as OmpModelLike[], {
    ompReports, codexbar: [], localState: {}, history: {}, intel, reservePct: 10, now: NOW,
  });
}

function frontierLadder(intel: IntelMap, previous?: string[]) {
  return computeLadders(DEFAULT_POLICY, frontierRoutes(intel), previous ? { frontier: previous } : {}).frontier;
}

/** Minimal ClassProfile for the ordering unit tests: one member per class unless given. */
function profilesOf(entries: Record<string, number | { power?: number; economics?: ClassEconomics; members?: string[] }>): Record<string, ClassProfile> {
  const profiles: Record<string, ClassProfile> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const spec = typeof entry === 'number' ? { power: entry } : entry;
    profiles[name] = {
      ...(spec.power === undefined ? {} : { power: spec.power }),
      economics: spec.economics ?? 'paid',
      members: spec.members ?? [name],
    };
  }
  return profiles;
}

test('benchmark power blends coding and agentic, and stays undefined without a measurement', () => {
  assert.equal(benchmarkPower(undefined), undefined);
  assert.equal(benchmarkPower({ taskFit: 0.9, popularity: 0.9 }), undefined, 'usage signals are not capability');
  assert.equal(benchmarkPower({ coding: 0.5 }), 0.5, 'a single-axis model is scored on that axis');
  // 0.63 * 0.8 + 0.37 * 0.5 — the coding:agentic ratio `qualityFromIntel` already uses.
  assert.equal(Number(benchmarkPower({ coding: 0.8, agentic: 0.5 })?.toFixed(4)), 0.689);
  assert.ok(
    (benchmarkPower({ coding: 0.8, agentic: 0.2 }) ?? 0) > (benchmarkPower({ coding: 0.2, agentic: 0.8 }) ?? 0),
    'coding dominates agentic at an equal magnitude',
  );
});

test('no snapshot leaves the shipped ladder untouched and its top rung keeps winning', () => {
  const routes = frontierRoutes({});
  assert.ok(routes.every((route) => route.benchmarkPower === undefined), 'precondition: nothing measured');
  const ladder = frontierLadder({});
  assert.equal(ladder.source, 'static');
  assert.deepEqual(ladder.order, DEFAULT_POLICY.tiers.frontier.classes);
  assert.equal(selectForTier(routes, ladder.order)?.className, 'astra-sub');
});

test('a measured snapshot lifts the stronger rung above the weaker one and the pick follows', () => {
  const routes = frontierRoutes(SNAPSHOT);
  const ladder = frontierLadder(SNAPSHOT);
  assert.equal(ladder.source, 'snapshot');
  assert.ok(
    ladder.order.indexOf('opus-sub') < ladder.order.indexOf('astra-sub'),
    `opus-sub must climb above astra-sub, got ${ladder.order.join(' > ')}`,
  );
  const pick = selectForTier(routes, ladder.order);
  assert.equal(pick?.className, 'opus-sub');
  assert.equal(pick?.route.provider, 'anthropic');
});

test('an unmeasured class never moves: it keeps the index the shipped policy gave it (I7)', () => {
  const base = ['top', 'pinned', 'middle', 'bottom'];
  const ladder = orderLadder(base, profilesOf({
    top: 0.9,
    middle: 0.5,
    bottom: 0.95,
  }));
  assert.deepEqual(ladder.unmeasured, ['pinned']);
  assert.equal(ladder.order.indexOf('pinned'), base.indexOf('pinned'));
  // `bottom` is the strongest, so it takes the first measured slot; the others hold their order.
  assert.deepEqual(ladder.order, ['bottom', 'pinned', 'top', 'middle']);
  assert.equal(ladder.source, 'snapshot');
});

test('a catch-all tail keeps its shipped index even when its best member is the strongest', () => {
  // `best-available` holds every paid route, so its best member is the strongest model in the
  // catalog by construction. Ordering it by that member would let the most expensive model in
  // the catalog jump the queue of the whole tier.
  const base = ['sonnet-sub', 'flash-payg', 'best-available'];
  const ladder = orderLadder(base, profilesOf({
    'sonnet-sub': { power: 0.6, economics: 'subscription', members: ['a/one'] },
    'flash-payg': { power: 0.55, economics: 'paid', members: ['b/two'] },
    'best-available': { power: 0.9, economics: 'paid', members: ['a/one', 'b/two'] },
  }));
  assert.deepEqual(ladder.order, base);
});

test('economics stays first order: a paid rung does not displace a subscription rung on power alone', () => {
  const base = ['sonnet-sub', 'flash-payg'];
  assert.deepEqual(
    orderLadder(base, profilesOf({
      'sonnet-sub': { power: 0.6, economics: 'subscription', members: ['a/one'] },
      'flash-payg': { power: 0.8, economics: 'paid', members: ['b/two'] },
    })).order,
    base,
  );
  // A mixed class may compete with paid capability classes, but cannot jump a pure
  // subscription rung: subscription-first is absolute.
  assert.deepEqual(
    orderLadder(base, profilesOf({
      'sonnet-sub': { power: 0.6, economics: 'subscription', members: ['a/one'] },
      'flash-payg': { power: 0.8, economics: 'mixed', members: ['b/two'] },
    })).order,
    base,
  );
  // Mixed can still move against a pure paid class.
  assert.deepEqual(
    orderLadder(['paid', 'mixed'], profilesOf({
      paid: { power: 0.6, economics: 'paid', members: ['a/one'] },
      mixed: { power: 0.8, economics: 'mixed', members: ['b/two'] },
    })).order,
    ['mixed', 'paid'],
  );
});

test('a gap below the margin does not reorder, and the previous order is what holds', () => {
  const base = ['left', 'right'];
  assert.deepEqual(
    orderLadder(base, profilesOf({ left: 0.61, right: 0.62 })).order,
    base,
    'a one-point wobble is noise, not a reordering',
  );
  assert.deepEqual(
    orderLadder(base, profilesOf({ left: 0.6, right: 0.6 + RUNG_HYSTERESIS })).order,
    ['right', 'left'],
    'a gap at the margin is a real ordering difference',
  );
  // Refreshes are sticky: an order the margin already decided is not revisited by a wobble.
  assert.deepEqual(
    orderLadder(base, profilesOf({ left: 0.5, right: 0.51 }), ['right', 'left']).order,
    ['right', 'left'],
  );
});

test('the computed ladder keeps the unmeasured rung pinned and hands over in order (I1, I7)', () => {
  const ladder = frontierLadder(SNAPSHOT);
  // No Fable route exists and nothing measured the class: it stays where the policy put it.
  assert.equal(ladder.order[0], 'fable-sub');
  assert.equal(ladder.order.indexOf('fable-sub'), DEFAULT_POLICY.tiers.frontier.classes.indexOf('fable-sub'));
  assert.ok(ladder.order.indexOf('opus-sub') < ladder.order.indexOf('astra-sub'));
  const out = frontierRoutes(SNAPSHOT).map((route) => (
    route.classes.includes('opus-sub')
      ? { ...route, health: { ...route.health, state: 'COOLDOWN' as const } }
      : route
  ));
  const pick = selectForTier(out, ladder.order);
  assert.equal(pick?.className, 'astra-sub');
});

test('a snapshot that measures nothing in a tier leaves that tier shipped', () => {
  const routes = frontierRoutes({ 'minimax/minimax-m3': { coding: 0.586, agentic: 0.295 } });
  const ladders = computeLadders(DEFAULT_POLICY, routes);
  assert.equal(ladders.frontier.source, 'static');
  assert.deepEqual(ladders.frontier.order, DEFAULT_POLICY.tiers.frontier.classes);
});

// ---------------------------------------------------------------------------------------------
// Wiring: the ladder must reach the actual routing decision, not just the module boundary.

interface StubModel {
  provider: string;
  id: string;
  cost: Record<string, number>;
}

interface TurnContext {
  models: {
    list: () => StubModel[];
    current: () => StubModel;
    resolve: (selector: string) => StubModel | undefined;
  };
  sessionManager: { getBranch: () => unknown[]; getSessionId: () => string };
  setTimeout: (callback: () => unknown) => void;
  setInterval: () => void;
  modelRegistry: { getApiKeyForProvider: () => Promise<string> };
  ui: { notify: () => void };
}

interface RungHarness {
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
  ctx: TurnContext;
  setModelCalls: StubModel[];
  scheduled: Array<() => unknown>;
}

function intelFetch(payloads: Record<string, unknown>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(payloads)) {
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const BENCHMARK_CODING = 'benchmarks?source=artificial-analysis&task_type=coding';
const BENCHMARK_AGENTIC = 'benchmarks?source=artificial-analysis&task_type=agentic';

const SNAPSHOT_PAYLOADS: Record<string, unknown> = {
  [BENCHMARK_CODING]: {
    data: [
      { model_permaslug: 'openai/gpt-6-astra', coding_index: 76.9 },
      { model_permaslug: 'anthropic/claude-opus-5', coding_index: 78 },
    ],
  },
  [BENCHMARK_AGENTIC]: {
    data: [
      { model_permaslug: 'openai/gpt-6-astra', agentic_index: 51 },
      { model_permaslug: 'anthropic/claude-opus-5', agentic_index: 56.5 },
    ],
  },
  'classifications/task': { data: [] },
  'datasets/rankings-daily': { data: [] },
};

const EMPTY_PAYLOADS: Record<string, unknown> = {
  ...SNAPSHOT_PAYLOADS,
  [BENCHMARK_CODING]: { data: [] },
  [BENCHMARK_AGENTIC]: { data: [] },
};

function harness(models: StubModel[], currentModel: StubModel, usage: string): RungHarness {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: StubModel[] = [];
  const scheduled: Array<() => unknown> = [];
  let current = currentModel;
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec(command: string, args: string[]) {
      if (command === 'omp' && args[0] === 'usage') return { code: 0, stdout: usage, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
    async setModel(model: StubModel) {
      setModelCalls.push(model);
      current = model;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: TurnContext = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((model) => `${model.provider}/${model.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 'rungs-test' },
    setTimeout(callback: () => unknown) { scheduled.push(callback); },
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => 'sk-or-test' },
    ui: { notify() {} },
  };
  // The host surface is much larger than the members the router touches; the stub is the
  // boundary, so it is cast once here rather than widened with loose members.
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  adaptiveRouter(pi as unknown as ExtensionAPI);
  return { handlers, ctx, setModelCalls, scheduled };
}

async function startSession(h: RungHarness): Promise<void> {
  for (const handler of h.handlers.get('session_start')!) await handler({}, h.ctx);
}

async function runScheduled(h: RungHarness): Promise<void> {
  while (h.scheduled.length) {
    const callback = h.scheduled.shift();
    await callback?.();
  }
}

async function turn(h: RungHarness): Promise<void> {
  for (const handler of h.handlers.get('before_agent_start')!) await handler({}, h.ctx);
}

const virtualFrontier: StubModel = { provider: 'pmr', id: 'frontier', cost: { input: 0, output: 0 } };

async function routedModel(payloads: Record<string, unknown>): Promise<string | undefined> {
  const restore = intelFetch(payloads);
  try {
    const h = harness([ASTRA, OPUS, virtualFrontier], virtualFrontier, usagePayload(['openai-codex', 'anthropic'], 1));
    await startSession(h);
    await runScheduled(h); // the snapshot lands here; the decision below is the one that uses it
    await turn(h);
    const last = h.setModelCalls.at(-1);
    return last ? `${last.provider}/${last.id}` : undefined;
  } finally {
    restore();
  }
}

test('the snapshot ladder reaches the routing decision: opus becomes the pick, astra is the fallback', async () => {
  assert.equal(await routedModel(EMPTY_PAYLOADS), 'openai-codex/gpt-6-astra', 'no snapshot: shipped ladder wins');
  assert.equal(await routedModel(SNAPSHOT_PAYLOADS), 'anthropic/claude-opus-5', 'snapshot: measured ladder wins');
});
