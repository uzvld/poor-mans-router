import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import adaptiveRouter from '../index.ts';
import { EMPTY_INTEL_CACHE, refreshOpenRouterIntel } from '../openrouter-intel.ts';
import { IntelStore } from '../state.ts';

// The OpenRouter Data API allows 500 requests per ACCOUNT per day, and one intel refresh costs
// four. Live 2026-10-09: the budget was spent, every refresh answered 429, the snapshot stayed
// empty, and all four PMR ladders silently fell back to policy.yml. The cache lived only in each
// process's memory, so every fresh OMP process (Multica/Hermes spawn one per attempt) refetched,
// and every live process retried all four requests every 15 minutes regardless of the 429.

const SCRATCH_STATE = join(tmpdir(), `pmr-test-state-intel-shared-${process.pid}.json`);
const SCRATCH_INTEL = SCRATCH_STATE.replace(/\.json$/, '.intel.json');

function cleanScratch(): void {
  rmSync(SCRATCH_STATE, { force: true });
  rmSync(SCRATCH_INTEL, { force: true });
}

const ASTRA = { provider: 'openai-codex', id: 'gpt-6-astra', cost: { input: 10, output: 50 } };
const OPUS = { provider: 'anthropic', id: 'claude-opus-5', cost: { input: 5, output: 25 } };
const FRONTIER = { provider: 'pmr', id: 'frontier', cost: { input: 0, output: 0 } };
type StubModel = typeof ASTRA;

// Measured 2026-09-22 (Artificial Analysis): with it, opus-sub climbs over astra-sub.
const SNAPSHOT_PAYLOADS: Record<string, unknown> = {
  'task_type=coding': { data: [
    { model_permaslug: 'openai/gpt-6-astra', coding_index: 76.9 },
    { model_permaslug: 'anthropic/claude-opus-5', coding_index: 78 },
  ] },
  'task_type=agentic': { data: [
    { model_permaslug: 'openai/gpt-6-astra', agentic_index: 51 },
    { model_permaslug: 'anthropic/claude-opus-5', agentic_index: 56.5 },
  ] },
  'classifications/task': { data: [] },
  'datasets/rankings-daily': { data: [] },
};

interface FetchStub { calls: string[]; restore: () => void }

function stubFetch(respond: (url: string) => Response): FetchStub {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function serveSnapshot(url: string): Response {
  for (const [needle, body] of Object.entries(SNAPSHOT_PAYLOADS)) {
    if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}

function rateLimited(resetAt: number): Response {
  return new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: datasets-per-account-rpd-v1.' } }), {
    status: 429,
    headers: { 'X-RateLimit-Limit': '500', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(resetAt) },
  });
}

function usagePayload(): string {
  const now = Date.now();
  return JSON.stringify({
    generatedAt: now,
    reports: ['openai-codex', 'anthropic'].map((provider) => ({
      provider,
      fetchedAt: now,
      limits: [{
        scope: { windowId: '7d', shared: true },
        amount: { remainingFraction: 1, usedFraction: 0 },
        window: { resetsAt: now + 3_600_000 },
        status: 'ok',
      }],
    })),
  });
}

interface Process {
  start: () => Promise<void>;
  runScheduled: () => Promise<void>;
  turn: () => Promise<string | undefined>;
}

/** One OMP process running the extension; every instance shares SCRATCH_STATE like real processes share state.json. */
function omProcess(): Process {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const scheduled: Array<() => unknown> = [];
  const models: StubModel[] = [ASTRA, OPUS, FRONTIER];
  let current: StubModel = FRONTIER;
  let lastSet: StubModel | undefined;
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerProvider() {},
    async exec(command: string, args: string[]) {
      if (command === 'omp' && args[0] === 'usage') return { code: 0, stdout: usagePayload(), stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
    async setModel(model: StubModel) {
      lastSet = model;
      current = model;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((model) => `${model.provider}/${model.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 'intel-shared' },
    setTimeout(callback: () => unknown) { scheduled.push(callback); },
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => 'sk-or-test' },
    ui: { notify() {} },
  };
  process.env.PMR_STATE_FILE = SCRATCH_STATE;
  // The host surface is much larger than the members the router touches; the stub is the boundary.
  adaptiveRouter(pi as unknown as ExtensionAPI);
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  return {
    start: () => emit('session_start'),
    runScheduled: async () => {
      while (scheduled.length) await scheduled.shift()?.();
    },
    turn: async () => {
      await emit('before_agent_start');
      return lastSet ? `${lastSet.provider}/${lastSet.id}` : undefined;
    },
  };
}

const dataApiCalls = (calls: string[]) => calls.filter((url) => url.startsWith('https://openrouter.ai/api/v1/'));

test('a process reuses the snapshot a peer fetched instead of spending the shared Data API budget', async () => {
  cleanScratch();
  const fetchStub = stubFetch(serveSnapshot);
  try {
    // Both processes are alive before either fetches: the second must see the first's
    // snapshot on disk, not only what it loaded at session_start.
    const first = omProcess();
    const second = omProcess();
    await first.start();
    await second.start();

    await first.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'precondition: one refresh is four Data API requests');

    // A long-lived process still running the previous release rewrites state.json with only the
    // fields it knows (install.sh warns about these). It must not erase the shared snapshot.
    writeFileSync(SCRATCH_STATE, JSON.stringify({ routes: {} }));

    await second.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'the peer snapshot is fresh: no second refresh');
    assert.equal(await second.turn(), 'anthropic/claude-opus-5', 'the shared snapshot drives the ladder');

    const third = omProcess(); // a fresh process spawned later (Multica/Hermes, one per attempt)
    await third.start();
    await third.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'a fresh process starts from the persisted snapshot');
    assert.equal(await third.turn(), 'anthropic/claude-opus-5');
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('a Data API 429 seen by one process stops every process until the advertised reset', async () => {
  cleanScratch();
  const fetchStub = stubFetch(() => rateLimited(Date.now() + 3 * 3_600_000));
  try {
    const first = omProcess();
    const second = omProcess();
    await first.start();
    await second.start();

    await first.runScheduled();
    const spent = dataApiCalls(fetchStub.calls).length;
    assert.ok(spent > 0, 'precondition: the first refresh reached the Data API');

    await second.runScheduled();
    const third = omProcess();
    await third.start();
    await third.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, spent, 'no process asks again before the reset');
    assert.equal(await third.turn(), 'openai-codex/gpt-6-astra', 'no snapshot: the shipped ladder still routes');
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('a refresh in flight in one process is not duplicated by a peer that starts meanwhile', async () => {
  cleanScratch();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstRequest: () => void = () => {};
  const requested = new Promise<void>((resolve) => { firstRequest = resolve; });
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (!url.startsWith('https://openrouter.ai/api/v1/')) return new Response('{}', { status: 404 }); // CodexBar
    firstRequest();
    await gate; // the first process's four Data API requests stay in flight
    return serveSnapshot(url);
  }) as typeof fetch;
  try {
    const first = omProcess();
    const second = omProcess();
    await first.start();
    await second.start();

    const inFlight = first.runScheduled();
    await requested;
    const peer = second.runScheduled();
    release();
    await Promise.all([inFlight, peer]);
    assert.equal(dataApiCalls(calls).length, 4, 'the peer sees the published attempt and waits out the retry floor');
  } finally {
    globalThis.fetch = real;
    cleanScratch();
  }
});

test('a 429 blocks the refresh until X-RateLimit-Reset, past the 15-minute retry floor, then resumes', async () => {
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const reset = now + 3 * 3_600_000;
  const ctx = { modelRegistry: { getApiKeyForProvider: async () => 'sk-or-test' } };

  const limited = stubFetch(() => rateLimited(reset));
  let cache;
  try {
    cache = await refreshOpenRouterIntel(ctx, { ...EMPTY_INTEL_CACHE }, now);
    assert.equal(cache.blockedUntil, reset);
    await refreshOpenRouterIntel(ctx, cache, now + 60 * 60_000);
    assert.equal(limited.calls.length, 4, 'an hour later is past the retry floor but still before the reset');
  } finally {
    limited.restore();
  }

  const recovered = stubFetch(serveSnapshot);
  try {
    const fresh = await refreshOpenRouterIntel(ctx, cache, reset + 1);
    assert.equal(recovered.calls.length, 4, 'the block ends at the reset');
    assert.ok(fresh.fetchedAt > 0);
    assert.equal(fresh.blockedUntil, undefined, 'a successful refresh clears the block');
  } finally {
    recovered.restore();
  }
});

test('a 429 whose reset is not in the future blocks until the next UTC day of the per-day quota', async () => {
  // Live the header carried the next 00:00 UTC; a missing or stale one must still block for the day.
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const ctx = { modelRegistry: { getApiKeyForProvider: async () => 'sk-or-test' } };
  const limited = stubFetch(() => rateLimited(Date.parse('2026-10-09T00:00:00.000Z')));
  try {
    const cache = await refreshOpenRouterIntel(ctx, { ...EMPTY_INTEL_CACHE }, now);
    assert.equal(cache.blockedUntil, Date.parse('2026-10-10T00:00:00.000Z'));
  } finally {
    limited.restore();
  }
});

test('a process saving a stale intel view keeps the newer snapshot and the block a peer wrote', () => {
  cleanScratch();
  try {
    const store = IntelStore.besideStateFile(SCRATCH_STATE);
    const fresh = { data: { 'anthropic/claude-opus-5': { coding: 0.78 } }, fetchedAt: 2_000, lastAttemptAt: 2_000 };
    store.save(fresh);
    // A peer that read the file before `fresh` landed, then hit a 429 on its own attempt.
    const saved = store.save({ data: {}, fetchedAt: 1_000, lastAttemptAt: 3_000, blockedUntil: 9_000 });
    assert.deepEqual(store.read(), saved);
    assert.deepEqual(saved.data, fresh.data, 'the newer snapshot survives');
    assert.equal(saved.fetchedAt, 2_000);
    assert.equal(saved.lastAttemptAt, 3_000, 'the latest attempt applies');
    assert.equal(saved.blockedUntil, 9_000, 'the block applies');
  } finally {
    cleanScratch();
  }
});
