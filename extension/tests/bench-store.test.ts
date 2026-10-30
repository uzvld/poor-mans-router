import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH_RETRY_FLOOR_MS, BENCH_TTL_MS, BenchStore, benchRefreshDue } from '../bench-store.ts';
import type { BenchSnapshot, BenchSource } from '../bench-types.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-bench-')), 'state.bench.json');
const snap = (source: BenchSource, fetchedAt: number, value = 0.5): BenchSnapshot => ({
  source,
  fetchedAt,
  sourceVersion: 'v',
  rows: [{ model: 'anthropic/claude-sonnet-5.5', observations: [{ facet: 'coding', value, confidence: 1, label: 't' }] }],
});

test('a snapshot written by one store is read back by another', async () => {
  const file = tmp();
  await new BenchStore(file).append(snap('lmarena', NOW - HOUR), NOW);
  const read = new BenchStore(file).read(NOW);
  assert.equal(read.history.lmarena?.length, 1);
  assert.equal(read.history.lmarena?.[0]?.rows[0]?.observations[0]?.value, 0.5);
});

test('the file sits beside state.json, like the intel cache', async () => {
  assert.equal(BenchStore.besideStateFile('/x/extension/state.json').filename, '/x/extension/state.bench.json');
  const file = tmp().replace('state.bench.json', 'state.json');
  const store = BenchStore.besideStateFile(file);
  await store.append(snap('epoch', NOW - HOUR), NOW);
  assert.equal(fs.existsSync(file.replace(/\.json$/, '.bench.json')), true);
});

test('only the newest 30 snapshots of a source are kept, oldest first', async () => {
  const store = new BenchStore(tmp());
  for (let day = 0; day < 35; day++) await store.append(snap('aa', NOW - (35 - day) * HOUR), NOW);
  const kept = store.read(NOW).history.aa ?? [];
  assert.equal(kept.length, 30);
  assert.equal(kept[0]?.fetchedAt, NOW - 30 * HOUR);
  assert.equal(kept.at(-1)?.fetchedAt, NOW - HOUR);
});

test('overlapping writes from different stores preserve both source histories', async () => {
  const file = tmp();
  const first = new BenchStore(file);
  const second = new BenchStore(file);
  const renameSync = fs.renameSync;
  let injected = false;
  let secondWrite: Promise<unknown> | unknown;
  fs.renameSync = ((from, to) => {
    if (to === file && !injected) {
      injected = true;
      secondWrite = second.append(snap('epoch', NOW - HOUR), NOW);
    }
    return renameSync(from, to);
  }) as typeof fs.renameSync;
  try {
    await first.append(snap('aa', NOW - HOUR), NOW);
    await secondWrite;
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(Object.keys(new BenchStore(file).read(NOW).history).sort(), ['aa', 'epoch']);
});
test('a killed writer owner is reclaimed before the next append', async () => {
  const store = new BenchStore(tmp());
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
  await once(child, 'spawn');
  const deadPid = child.pid;
  assert.ok(deadPid);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

  const lock = `${store.filename}.write.lock`;
  const deadOwner = `pmr-bench-writer:${deadPid}:dead-token`;
  fs.symlinkSync(deadOwner, lock);
  const append = store.append(snap('epoch', NOW - HOUR), NOW);
  const ownerAfterAttempt = fs.readlinkSync(lock);
  if (ownerAfterAttempt === deadOwner) fs.rmSync(lock, { force: true });
  await append;

  assert.notEqual(ownerAfterAttempt, deadOwner);
  assert.equal(new BenchStore(store.filename).read(NOW).history.epoch?.length, 1);
});

test('an old lock from a live owner is not reclaimed by age', async () => {
  const store = new BenchStore(tmp());
  await store.append(snap('aa', NOW - 2 * HOUR), NOW);
  const before = fs.readFileSync(store.filename, 'utf8');
  const lock = `${store.filename}.write.lock`;
  const liveOwner = `pmr-bench-writer:${process.pid}:live-token`;
  fs.symlinkSync(liveOwner, lock);
  fs.lutimesSync(lock, new Date(0), new Date(0));

  const append = store.append(snap('epoch', NOW - HOUR), NOW);
  const ownerAfterAttempt = fs.readlinkSync(lock);
  const contentsDuringWait = fs.readFileSync(store.filename, 'utf8');
  fs.rmSync(lock, { force: true });
  await append;

  assert.equal(ownerAfterAttempt, liveOwner);
  assert.equal(contentsDuringWait, before);
  assert.deepEqual(Object.keys(store.read(NOW).history).sort(), ['aa', 'epoch']);
});

test('a malformed writer lock fails within a bounded wait without replacing the last snapshot', async () => {
  const store = new BenchStore(tmp());
  await store.append(snap('aa', NOW - 2 * HOUR), NOW);
  const before = fs.readFileSync(store.filename, 'utf8');
  const lock = `${store.filename}.write.lock`;
  fs.writeFileSync(lock, 'not-a-symlink');

  const append = store.append(snap('epoch', NOW - HOUR), NOW);
  type Outcome = { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | { kind: 'timeout' };
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race<Outcome>([
    append.then<Outcome>(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error }),
    ),
    new Promise<Outcome>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), 250);
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.kind === 'timeout') {
    fs.rmSync(lock, { force: true });
    await append;
  }

  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.kind === 'rejected' ? String(outcome.error) : '', /malformed benchmark writer lock/);
  assert.equal(fs.readFileSync(store.filename, 'utf8'), before);
});


test('an append with a stale fetch-start time preserves a newer peer snapshot', async () => {
  const store = new BenchStore(tmp());
  const peerAt = Date.now();
  await store.append(snap('epoch', peerAt), peerAt);
  const staleNow = peerAt - 1000;
  await store.append(snap('lmarena', staleNow), staleNow);
  await store.recordAttempt('epoch', peerAt);
  await store.recordAttempt('epoch', staleNow);
  const read = store.read(Date.now());
  assert.deepEqual(Object.keys(read.history).sort(), ['epoch', 'lmarena']);
  assert.equal(read.attempts.epoch, peerAt);
});


test('the same snapshot written twice is stored once', async () => {
  const store = new BenchStore(tmp());
  await store.append(snap('aa', NOW - HOUR), NOW);
  await store.append(snap('aa', NOW - HOUR), NOW);
  assert.equal(store.read(NOW).history.aa?.length, 1);
});

test('a snapshot with no rows is refused: a 200 with nothing must not replace a good snapshot', async () => {
  const store = new BenchStore(tmp());
  await store.append(snap('aa', NOW - 2 * HOUR), NOW);
  await assert.rejects(async () => store.append({ ...snap('aa', NOW - HOUR), rows: [] }, NOW));
  assert.equal(store.read(NOW).history.aa?.length, 1);
});

test('a corrupted file, a future-dated snapshot and a damaged row read as nothing, never as data', () => {
  const file = tmp();
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new BenchStore(file).read(NOW), { history: {}, attempts: {} });

  const good = snap('aa', NOW - HOUR);
  const future = snap('aa', NOW + 5 * HOUR);
  const damaged = { ...snap('aa', NOW - 3 * HOUR), rows: [{ model: 'x/y', observations: [{ facet: 'coding', value: null, confidence: 1, label: 't' }] }] };
  fs.writeFileSync(file, JSON.stringify({ history: { aa: [damaged, good, future] }, attempts: { aa: NOW + 9 * HOUR } }));
  const read = new BenchStore(file).read(NOW);
  assert.deepEqual(read.history.aa?.map((s) => s.fetchedAt), [NOW - HOUR]);
  assert.equal(read.attempts.aa, undefined, 'an attempt time in the future would block refreshes forever');
});

test('a snapshot filed under the wrong source is dropped', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ history: { epoch: [snap('lmarena', NOW - HOUR)] }, attempts: {} }));
  assert.equal(new BenchStore(file).read(NOW).history.epoch, undefined);
});

test('refresh is due after 24 h, not before, and not within 15 minutes of an attempt', async () => {
  const store = new BenchStore(tmp());
  await store.append(snap('epoch', NOW - 23 * HOUR), NOW);
  assert.equal(benchRefreshDue(store.read(NOW), 'epoch', NOW), false);
  assert.equal(benchRefreshDue(store.read(NOW), 'epoch', NOW + 2 * HOUR), true);

  await store.recordAttempt('epoch', NOW + 2 * HOUR - 14 * 60_000);
  assert.equal(benchRefreshDue(store.read(NOW + 2 * HOUR), 'epoch', NOW + 2 * HOUR), false, 'a failed fetch 14 min ago is not retried yet');
  assert.equal(benchRefreshDue(store.read(NOW + 2 * HOUR), 'epoch', NOW + 2 * HOUR + 2 * 60_000), true);
});

test('a source never fetched is due at once, and the constants are the documented ones', () => {
  assert.equal(benchRefreshDue(new BenchStore(tmp()).read(NOW), 'benchlm', NOW), true);
  assert.equal(BENCH_TTL_MS, 24 * HOUR);
  assert.equal(BENCH_RETRY_FLOOR_MS, 15 * 60_000);
});

test('the machine-wide claim admits one holder at a time', () => {
  const store = new BenchStore(tmp());
  const first = store.claim();
  assert.ok(first);
  assert.equal(new BenchStore(store.filename).claim(), undefined);
  first?.();
  assert.ok(store.claim());
});
