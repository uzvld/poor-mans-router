import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAaSnapshot, refreshKeylessSources, type BenchFetchers } from '../bench-refresh.ts';
import { BENCH_RETRY_FLOOR_MS, BENCH_TTL_MS, BenchStore } from '../bench-store.ts';
import type { BenchSnapshot, BenchSource } from '../bench-types.ts';
import type { IntelCache } from '../openrouter-intel.ts';
import { synthetic } from './bench-fixtures.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const store = () => new BenchStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-refresh-')), 'state.bench.json'));

function fetchers(overrides: Partial<Record<Exclude<BenchSource, 'aa'>, (now: number) => Promise<BenchSnapshot>>> = {}) {
  const calls: string[] = [];
  const make = (source: Exclude<BenchSource, 'aa'>) => async (now: number): Promise<BenchSnapshot> => {
    calls.push(source);
    return synthetic(source, { 'v/m0': { coding: 0.5 } }, { fetchedAt: now });
  };
  const all: BenchFetchers = { epoch: make('epoch'), benchlm: make('benchlm'), lmarena: make('lmarena'), ...overrides };
  return { all, calls };
}

const quiet = () => {};

test('every source never fetched is fetched once, and none again inside 24 h', async () => {
  const s = store();
  const f = fetchers();
  assert.equal(await refreshKeylessSources(s, f.all, NOW, quiet), true);
  assert.deepEqual(f.calls.sort(), ['benchlm', 'epoch', 'lmarena']);
  assert.equal(await refreshKeylessSources(s, f.all, NOW + 23 * HOUR, quiet), false);
  assert.equal(f.calls.length, 3);
  assert.equal(await refreshKeylessSources(s, f.all, NOW + 25 * HOUR, quiet), true);
  assert.equal(f.calls.length, 6);
  assert.equal(s.read(NOW + 25 * HOUR).history.epoch?.length, 2);
});

test('one source failing leaves the others stored and is not retried inside 15 minutes', async () => {
  const s = store();
  const logged: string[] = [];
  const f = fetchers({ epoch: async () => { throw new Error('boom'); } });
  assert.equal(await refreshKeylessSources(s, f.all, NOW, (message) => logged.push(message)), true);
  assert.equal(s.read(NOW).history.epoch, undefined);
  assert.deepEqual(Object.keys(s.read(NOW).history).sort(), ['benchlm', 'lmarena']);
  assert.match(logged.join('\n'), /epoch/);

  assert.equal(await refreshKeylessSources(s, f.all, NOW + BENCH_RETRY_FLOOR_MS - 60_000, quiet), false, 'inside the retry floor');
  const recovered = fetchers();
  assert.equal(await refreshKeylessSources(s, recovered.all, NOW + BENCH_RETRY_FLOOR_MS + 60_000, quiet), true);
  assert.deepEqual(recovered.calls, ['epoch']);
});

test('a fetcher that returns nothing usable stores nothing and the last good snapshot stays', async () => {
  const s = store();
  await refreshKeylessSources(s, fetchers().all, NOW, quiet);
  const empty = fetchers({ lmarena: async (now) => ({ ...synthetic('lmarena', {}, { fetchedAt: now }), rows: [] }) });
  assert.equal(await refreshKeylessSources(s, empty.all, NOW + 25 * HOUR, quiet), true, 'the other two landed');
  const lmarena = s.read(NOW + 25 * HOUR).history.lmarena ?? [];
  assert.deepEqual(lmarena.map((snapshot) => snapshot.fetchedAt), [NOW]);
});

test('a source another process is already refreshing is left to it', async () => {
  // The claim's age is the lock file's mtime, so this test runs on the real clock.
  const now = Date.now();
  const s = store();
  const release = s.claim();
  assert.ok(release);
  const f = fetchers();
  assert.equal(await refreshKeylessSources(s, f.all, now, quiet), false);
  assert.deepEqual(f.calls, []);
  release?.();
  assert.equal(await refreshKeylessSources(s, f.all, now, quiet), true);
});
test('the claim is released after a failure, so a failing source never wedges the others or the next refresh', async () => {
  const s = store();
  const f = fetchers({ epoch: async () => { throw new Error('boom'); } });
  await refreshKeylessSources(s, f.all, NOW, quiet);
  const again = s.claim();
  assert.ok(again, 'the lock is free');
  again?.();
});

// --- AA --------------------------------------------------------------------------------------------

const cache = (fetchedAt: number, data: IntelCache['data'] = { 'anthropic/claude-sonnet-5-20260630': { coding: 0.7 } }): IntelCache => ({ data, fetchedAt, lastAttemptAt: fetchedAt });

test('the AA cache is stored as a snapshot at most once in 24 h', () => {
  const s = store();
  assert.equal(recordAaSnapshot(s, cache(NOW - 30 * HOUR), NOW), true);
  assert.equal(recordAaSnapshot(s, cache(NOW - 30 * HOUR), NOW), false, 'the same cache twice is one snapshot');
  assert.equal(recordAaSnapshot(s, cache(NOW - 10 * HOUR), NOW), false, 'a six-hourly refresh inside the day is not a new day');
  assert.equal(recordAaSnapshot(s, cache(NOW - 30 * HOUR + BENCH_TTL_MS + HOUR), NOW), true);
  assert.equal(s.read(NOW).history.aa?.length, 2);
});

test('an empty or never-fetched AA cache stores nothing and does not throw', () => {
  const s = store();
  assert.equal(recordAaSnapshot(s, cache(0), NOW), false);
  assert.equal(recordAaSnapshot(s, cache(NOW - HOUR, {}), NOW), false);
  assert.equal(recordAaSnapshot(s, cache(NOW - HOUR, { 'anthropic/claude-x': { popularity: 0.9 } }), NOW), false);
  assert.equal(s.read(NOW).history.aa, undefined);
});
