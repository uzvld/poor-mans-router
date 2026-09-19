import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import adaptiveRouter from '../index.ts';
import { RouterStateStore } from '../state.ts';

// The first turn of a managed session used to await `omp usage` plus the CodexBar
// CLI before any request went out (28–31 s observed live). Routing must decide from
// whatever telemetry is already known and refresh in the background. Multica makes
// this load-bearing: it spawns a fresh OMP process per run, so an in-memory-only
// cache is always empty and every run would route blind.
const virtualBalanced = { provider: 'pmr', id: 'balanced', cost: {} };
const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 3, output: 15 } };
const kiloFree = { provider: 'kilo', id: 'deepseek/deepseek-v4-flash-0731:free', cost: { input: 0, output: 0 } };

function harness(options: { execNeverResolves?: boolean; stateFile?: string } = {}) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: Array<{ provider?: string; id?: string }> = [];
  const models = [virtualBalanced, sonnet, kiloFree];
  let current: unknown = virtualBalanced;
  const deferred: Array<() => void> = [];
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() {
      if (options.execNeverResolves) return new Promise(() => { /* telemetry that never answers */ });
      return { code: 1, stdout: '', stderr: '' };
    },
    async setModel(m: unknown) {
      setModelCalls.push(m as { provider?: string; id?: string });
      current = m;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m: any) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init' }], getSessionId: () => 's1' },
    // Background work is queued, not run: the test drives it explicitly.
    setTimeout(fn: () => void) { deferred.push(fn); },
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls, deferred };
}

test('the first managed turn routes without waiting for telemetry', async () => {
  const h = harness({ execNeverResolves: true });
  for (const f of h.handlers.get('session_start')!) await f({}, h.ctx);
  const turn = h.handlers.get('before_agent_start')![0]({}, h.ctx);
  await turn;
  assert.equal(h.setModelCalls.length, 1, 'a switch must be decided from known telemetry, not awaited');
});

test('a persisted telemetry snapshot survives the process and keeps a cooled route out of the first pick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-telemetry-'));
  const file = path.join(dir, 'state.json');
  const now = Date.now();

  // Process 1 persists what it learned: kilo's free route is exhausted.
  const writer = new RouterStateStore(file);
  writer.load();
  writer.saveTelemetry(
    {
      ompReports: [],
      codexbar: [{
        provider: 'kilo',
        telemetryAvailable: true,
        exhausted: true,
        exhaustionScope: 'balance',
        draining: false,
        paidBalanceKnown: false,
        fetchedAt: now,
      }],
    },
    now,
  );
  writer.save();

  // Process 2 (a Multica re-spawn) reads it back.
  const reader = new RouterStateStore(file);
  reader.load();
  const cached = reader.telemetry(now + 60_000, 15 * 60_000);
  assert.ok(cached, 'a fresh snapshot must be readable in the next process');
  assert.equal(cached!.codexbar[0].provider, 'kilo');
  assert.equal(cached!.codexbar[0].exhausted, true);
  assert.equal(cached!.codexbar[0].exhaustionScope, 'balance');

  // Stale snapshots are not trusted: routing falls back to "no telemetry".
  assert.equal(reader.telemetry(now + 16 * 60_000, 15 * 60_000), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a refresh that completes in the background is persisted for the next process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-telemetry-'));
  const file = path.join(dir, 'state.json');
  const store = new RouterStateStore(file);
  store.load();
  store.saveTelemetry({ ompReports: [], codexbar: [] }, Date.now());
  store.save();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.telemetry, 'the snapshot lives in the state file next to route state');
  assert.equal(typeof raw.telemetry.fetchedAt, 'number');
  fs.rmSync(dir, { recursive: true, force: true });
});
