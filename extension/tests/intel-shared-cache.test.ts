import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import adaptiveRouter from '../index.ts';
import { EMPTY_INTEL_CACHE, fetchOpenRouterIntel, intelRefreshDue } from '../openrouter-intel.ts';
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
  rmSync(SCRATCH_INTEL, { recursive: true, force: true });
  rmSync(`${SCRATCH_INTEL}.lock`, { recursive: true, force: true });
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
  /** Fire every pending timer in the same tick, the way a host can fire session_start's and the first turn's. */
  runScheduledTogether: () => Promise<void>;
  turn: () => Promise<string | undefined>;
}

/** One OMP process running the extension; every instance shares SCRATCH_STATE like real processes share state.json. */
function omProcess(options: { apiKey?: string; onKeyRequest?: () => void } = { apiKey: 'sk-or-test' }): Process {
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
    modelRegistry: {
      getApiKeyForProvider: async () => {
        options.onKeyRequest?.(); // the await point where a real peer can finish its refresh
        return options.apiKey;
      },
    },
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
    runScheduledTogether: async () => {
      await Promise.all(scheduled.splice(0).map((callback) => callback()));
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

  const limited = stubFetch(() => rateLimited(reset));
  let cache;
  try {
    cache = await fetchOpenRouterIntel('sk-or-test', { ...EMPTY_INTEL_CACHE }, now);
    assert.equal(cache.blockedUntil, reset);
    assert.equal(intelRefreshDue(cache, now + 60 * 60_000), false, 'an hour later is past the retry floor but still before the reset');
  } finally {
    limited.restore();
  }

  assert.equal(intelRefreshDue(cache, reset + 1), true, 'the block ends at the reset');
  const recovered = stubFetch(serveSnapshot);
  try {
    const fresh = await fetchOpenRouterIntel('sk-or-test', cache, reset + 1);
    assert.ok(fresh.fetchedAt > 0);
    assert.equal(fresh.blockedUntil, undefined, 'a successful refresh returns no block');
  } finally {
    recovered.restore();
  }
});

test('a daily-quota 429 whose reset is not in the future blocks until the next UTC day', async () => {
  // Live the header carried the next 00:00 UTC; a missing or stale one must still block for the day.
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const limited = stubFetch(() => rateLimited(Date.parse('2026-10-09T00:00:00.000Z')));
  try {
    const cache = await fetchOpenRouterIntel('sk-or-test', { ...EMPTY_INTEL_CACHE }, now);
    assert.equal(cache.blockedUntil, Date.parse('2026-10-10T00:00:00.000Z'));
  } finally {
    limited.restore();
  }
});

test('a process saving a stale intel view keeps the newer snapshot and the block a peer wrote', () => {
  cleanScratch();
  try {
    const store = IntelStore.besideStateFile(SCRATCH_STATE);
    const now = Date.now();
    const fresh = { data: { 'anthropic/claude-opus-5': { coding: 0.78 } }, fetchedAt: now - 2_000, lastAttemptAt: now - 2_000 };
    store.save(fresh);
    // A peer that read the file before `fresh` landed, then hit a 429 on its own attempt.
    const blockedUntil = now + 3 * 3_600_000;
    const saved = store.save({ data: {}, fetchedAt: now - 9_000, lastAttemptAt: now - 1_000, blockedUntil });
    assert.deepEqual(store.read(), saved);
    assert.deepEqual(saved.data, fresh.data, 'the newer snapshot survives');
    assert.equal(saved.fetchedAt, now - 2_000);
    assert.equal(saved.lastAttemptAt, now - 1_000, 'the latest attempt applies');
    assert.equal(saved.blockedUntil, blockedUntil, 'the block applies');
  } finally {
    cleanScratch();
  }
});

test('processes that refresh in the same tick spend one refresh between them', async () => {
  cleanScratch();
  const fetchStub = stubFetch(serveSnapshot);
  try {
    const peers = [omProcess(), omProcess(), omProcess()];
    for (const peer of peers) await peer.start();
    // Multica/Hermes start processes together: every one reads the file before any one writes.
    await Promise.all(peers.map((peer) => peer.runScheduledTogether()));
    assert.equal(dataApiCalls(fetchStub.calls).length, 4);
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('one process whose session-start and first-turn refreshes fire together spends one refresh', async () => {
  cleanScratch();
  // Without a usable machine-wide lock (an old directory sits at its path: it cannot be created,
  // read as a claim, or removed) the process refreshes unshared; it must still not refresh twice.
  mkdirSync(`${SCRATCH_INTEL}.lock`);
  mkdirSync(`${SCRATCH_INTEL}.lock/held`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(`${SCRATCH_INTEL}.lock`, old, old);
  const fetchStub = stubFetch(serveSnapshot);
  try {
    const solo = omProcess();
    await solo.start();
    await solo.turn(); // schedules a second refresh behind session_start's
    await solo.runScheduledTogether();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4);
  } finally {
    fetchStub.restore();
    rmSync(`${SCRATCH_INTEL}.lock`, { recursive: true, force: true });
    cleanScratch();
  }
});

test('a live peer\'s claim holds a process off, and a dead peer\'s stale claim is reclaimed', async () => {
  cleanScratch();
  const fetchStub = stubFetch(serveSnapshot);
  try {
    writeFileSync(`${SCRATCH_INTEL}.lock`, String(Date.now())); // a peer mid-refresh in another process
    const waiting = omProcess();
    await waiting.start();
    await waiting.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 0, 'the peer is spending the requests');

    const deadAt = new Date(Date.now() - 10 * 60_000); // that peer died mid-refresh
    utimesSync(`${SCRATCH_INTEL}.lock`, deadAt, deadAt);
    const next = omProcess();
    await next.start();
    await next.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'a stale claim does not block forever');
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('a snapshot a peer lands while this process resolves its key is used, not refetched', async () => {
  cleanScratch();
  const fetchStub = stubFetch(serveSnapshot);
  try {
    const now = Date.now();
    const late = omProcess({
      apiKey: 'sk-or-test',
      // The peer finished and released its claim after this process first read the file.
      onKeyRequest: () => {
        IntelStore.besideStateFile(SCRATCH_STATE).save({ data: { 'anthropic/claude-opus-5': { coding: 0.78, agentic: 0.565 } }, fetchedAt: now, lastAttemptAt: now });
      },
    });
    await late.start();
    await late.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 0);
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('a process without an OpenRouter key does not hold back a peer that has one', async () => {
  cleanScratch();
  const fetchStub = stubFetch(serveSnapshot);
  try {
    const keyless = omProcess({ apiKey: undefined });
    await keyless.start();
    await keyless.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 0, 'precondition: no key, no request');

    const keyed = omProcess();
    await keyed.start();
    await keyed.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'nothing was attempted, so nothing is waited out');
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('an unwritable intel file costs the sharing, not the ratings', async () => {
  cleanScratch();
  mkdirSync(SCRATCH_INTEL); // a directory where the file should be: every read and rename fails
  const fetchStub = stubFetch(serveSnapshot);
  try {
    const solo = omProcess();
    await solo.start();
    await solo.runScheduled();
    assert.equal(dataApiCalls(fetchStub.calls).length, 4, 'the refresh still runs');
    assert.equal(await solo.turn(), 'anthropic/claude-opus-5', 'and its snapshot still drives the ladder');
  } finally {
    fetchStub.restore();
    rmSync(SCRATCH_INTEL, { recursive: true, force: true });
    cleanScratch();
  }
});

test('an implausible block from the header or the file is bounded to one day', async () => {
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const fetchStub = stubFetch(() => rateLimited(1e18));
  try {
    const cache = await fetchOpenRouterIntel('sk-or-test', { ...EMPTY_INTEL_CACHE }, now);
    assert.equal(cache.blockedUntil, now + 86_400_000, 'header 1e18 is capped at one day');
  } finally {
    fetchStub.restore();
  }

  // A corrupt or hand-edited file: the same bound applies on read, so /route-status can format it.
  cleanScratch();
  writeFileSync(SCRATCH_INTEL, JSON.stringify({ data: {}, fetchedAt: 0, lastAttemptAt: 0, blockedUntil: 1e18 }));
  try {
    const readAt = Date.now();
    const read = IntelStore.besideStateFile(SCRATCH_STATE).read(readAt);
    assert.equal(read?.blockedUntil, readAt + 86_400_000);
  } finally {
    cleanScratch();
  }
});

test('a 429 that is not the daily quota and carries no reset does not block for the day', async () => {
  cleanScratch();
  const burst = () => new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: 30 requests per minute.' } }), { status: 429 });
  const fetchStub = stubFetch(burst);
  try {
    const solo = omProcess();
    await solo.start();
    await solo.runScheduled();
    assert.equal(IntelStore.besideStateFile(SCRATCH_STATE).read()?.blockedUntil, undefined, 'the 15-minute retry floor is enough');
  } finally {
    fetchStub.restore();
    cleanScratch();
  }
});

test('the intel file rejects data that is not a model map', () => {
  cleanScratch();
  try {
    writeFileSync(SCRATCH_INTEL, JSON.stringify({ data: [], fetchedAt: 1, lastAttemptAt: 1 }));
    assert.equal(IntelStore.besideStateFile(SCRATCH_STATE).read(), undefined);
    writeFileSync(SCRATCH_INTEL, JSON.stringify({ data: { 'a/b': 'x' }, fetchedAt: 1, lastAttemptAt: 1 }));
    assert.equal(IntelStore.besideStateFile(SCRATCH_STATE).read(), undefined);
  } finally {
    cleanScratch();
  }
});

test('an expired block is dropped from the file instead of merged back forever', () => {
  cleanScratch();
  try {
    const store = IntelStore.besideStateFile(SCRATCH_STATE);
    const now = Date.now();
    store.save({ data: {}, fetchedAt: 0, lastAttemptAt: now - 60_000, blockedUntil: now - 1 });
    const saved = store.save({ data: { 'a/b': { coding: 0.5 } }, fetchedAt: now, lastAttemptAt: now });
    assert.equal(saved.blockedUntil, undefined);
    assert.equal(store.read()?.blockedUntil, undefined);
  } finally {
    cleanScratch();
  }
});
