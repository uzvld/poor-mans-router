import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import adaptiveRouter from '../index.ts';
import { BenchStore } from '../bench-store.ts';
import { IntelStore } from '../state.ts';
import { AA_INTEL, fixtureJson, fixtureText, liveHistory } from './bench-fixtures.ts';

// The real extension, the real policy.yml, the 2026-10-30 capture in place of the network: the evidence
// stored on disk must reach the model the router picks, and a source that fails must never reach a turn.
const HOUR = 3_600_000;

interface Model { provider: string; id: string; cost?: object }
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

async function harness(options: { seedBench: boolean; seedAa?: boolean; rejectApiKey?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-wiring-'));
  const stateFile = path.join(dir, 'state.json');
  process.env.PMR_STATE_FILE = stateFile;
  const now = Date.now();

  if (options.seedAa !== false) {
    IntelStore.besideStateFile(stateFile).save({ data: AA_INTEL, fetchedAt: now - HOUR, lastAttemptAt: now - HOUR }, now);
  }
  const benchStore = BenchStore.besideStateFile(stateFile);
  if (options.seedBench) {
    for (const snapshots of Object.values(liveHistory())) {
      for (const snapshot of snapshots ?? []) await benchStore.append({ ...snapshot, fetchedAt: now - HOUR }, now);
    }
  }

  const virtual: Model = { provider: 'pmr', id: 'balanced', cost: {} };
  const models: Model[] = [virtual, ...fixtureJson<{ models: Model[] }>('omp-models.json').models];
  let current: Model = virtual;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const scheduled: Array<() => unknown> = [];
  const notices: string[] = [];
  const setModelCalls: Model[] = [];

  const pi = {
    setLabel() {},
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerProvider() {},
    async exec(command: string, args: string[]) {
      if (command === 'omp' && args[0] === 'usage') return { code: 0, stdout: fixtureText('omp-usage.json'), stderr: '' };
      if (command === 'omp' && args[0] === 'stats') return { code: 0, stdout: fixtureText('omp-stats.json'), stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    },
    async setModel(model: Model) { setModelCalls.push(model); current = model; return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init' }], getSessionId: () => 's1' },
    setTimeout(callback: () => unknown) { scheduled.push(callback); },
    setInterval() {},
    modelRegistry: {
      getApiKeyForProvider: async () => {
        if (options.rejectApiKey) throw new Error('credential lookup failed');
        return undefined;
      },
    },
    ui: { notify(text: string) { notices.push(text) } },
  };
  // The extension takes the host's API object; this is the part of it the router reads and writes.
  adaptiveRouter(pi as unknown as Parameters<typeof adaptiveRouter>[0]);

  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  return {
    benchStore,
    notices,
    setModelCalls,
    async start() { await emit('session_start'); },
    async runScheduled() { while (scheduled.length) await scheduled.shift()?.(); },
    async turn() { await emit('before_agent_start'); return setModelCalls.at(-1)?.id; },
    async routeStatus() { await commands.get('route-status')?.handler('', ctx); return notices.at(-1) ?? ''; },
  };
}

/** Replace `fetch` for one test; returns the URLs asked for and a restore function. */
function failingFetch() {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/127\.0\.0\.1|localhost/.test(url)) urls.push(url);
    throw new Error('network down');
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}

test('the evidence stored on disk decides the first managed turn: balanced lands on sonnet-5-5', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: true });
    await h.start();
    await h.runScheduled();
    assert.equal(await h.turn(), 'claude-sonnet-5-5');
    assert.deepEqual(net.urls, [], 'fresh snapshots are not fetched again');
  } finally {
    net.restore();
  }
});

test('the AA cache alone, with no other source stored, still lands on sonnet-5-5: its intelligence index counts under the tier weights', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: false });
    await h.start();
    await h.runScheduled();
    assert.equal(await h.turn(), 'claude-sonnet-5-5');
  } finally {
    net.restore();
  }
});

test('every source down: the turn is routed all the same, each source is tried, and none again inside the retry floor', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: false });
    await h.start();
    await h.runScheduled();
    assert.equal(await h.turn(), 'claude-sonnet-5-5', 'a failed refresh never reaches the turn');
    const hosts = new Set(net.urls.map((url) => new URL(url).host));
    assert.deepEqual([...hosts].sort(), ['benchlm.ai', 'datasets-server.huggingface.co', 'epoch.ai']);
    const attempts = h.benchStore.read().attempts;
    assert.deepEqual(Object.keys(attempts).sort(), ['benchlm', 'epoch', 'lmarena']);

    const before = net.urls.length;
    await h.runScheduled(); // the next turn's refresh timer
    await h.turn();
    await h.runScheduled();
    assert.equal(net.urls.length, before, 'inside 15 minutes nothing is retried');
  } finally {
    net.restore();
  }
});

test('keyless benchmarks refresh when the AA credential lookup rejects', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: false, seedAa: false, rejectApiKey: true });
    await h.start();
    await h.runScheduled();
    const hosts = new Set(net.urls.map((url) => new URL(url).host));
    assert.deepEqual([...hosts].sort(), ['benchlm.ai', 'datasets-server.huggingface.co', 'epoch.ai']);
    assert.deepEqual(Object.keys(h.benchStore.read().attempts).sort(), ['benchlm', 'epoch', 'lmarena']);
  } finally {
    net.restore();
  }
});

test('the AA cache becomes the day\u2019s snapshot in the store, so a later re-baseline can be seen', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: false });
    await h.start();
    await h.runScheduled();
    assert.equal(h.benchStore.read().history.aa?.length, 1);
  } finally {
    net.restore();
  }
});

test('/route-status reports each source, what they said about the chosen model, and credits them', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: true });
    await h.start();
    await h.runScheduled();
    await h.turn();
    const text = await h.routeStatus();
    assert.match(text, /^benchmarks:$/m);
    assert.match(text, /Epoch AI: 1h old · data 2026-10-\d\d · \d+ models/);
    assert.match(text, /LMArena: 1h old · data 2026-10-28/);
    assert.match(text, /anthropic\/claude-sonnet-5\.5:/);
    assert.match(text, /epoch FrontierSWE 0\.619→/);
    assert.match(text, /Data from BenchLM\.ai/);
    assert.doesNotMatch(text, /sk-or-|@/);
  } finally {
    net.restore();
  }
});

test('with no benchmark evidence at all the router still routes and /route-status simply has no benchmark section', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: false, seedAa: false });
    await h.start();
    await h.runScheduled();
    assert.ok(await h.turn(), 'a model was chosen from the shipped policy');
    assert.doesNotMatch(await h.routeStatus(), /Epoch AI:|LMArena:/);
  } finally {
    net.restore();
  }
});

test('a late source snapshot changes the pick even when another source has a newer timestamp', async () => {
  const net = failingFetch();
  try {
    const h = await harness({ seedBench: true });
    const initial = h.benchStore.read();
    const latestOther = Math.max(...Object.values(initial.history).flatMap((snapshots) => snapshots?.map((s) => s.fetchedAt) ?? []));
    delete initial.history.benchlm;
    fs.writeFileSync(h.benchStore.filename, JSON.stringify(initial));
    await h.start();
    await h.runScheduled();
    assert.equal(await h.turn(), 'claude-sonnet-5-5');

    const late = liveHistory().benchlm?.[0];
    assert.ok(late);
    await h.benchStore.append({
      ...late,
      fetchedAt: latestOther - HOUR,
      rows: late.rows.map((row) => row.model === 'anthropic/claude-sonnet-5.5'
        ? { ...row, observations: row.observations.map((observation) => ({ ...observation, value: 0, confidence: 1 })) }
        : row),
    });
    await h.start();
    await h.runScheduled();
    assert.equal(await h.turn(), 'claude-sonnet-5');
  } finally {
    net.restore();
  }
});
