import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStateStore } from '../state.ts';

test('persists only operational route state and reloads it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-router-'));
  const file = path.join(dir, 'state.json');
  const store = new RouterStateStore(file);
  store.markCooldown('p/m', 5000, '429', 1000);
  store.recordSuccess('p/m', 2000);
  store.save();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(disk), ['routes']);
  assert.equal(disk.routes['p/m'].cooldownUntil, 5000);
  assert.equal(disk.routes['p/m'].lastSuccessAt, 2000);
  assert.equal(JSON.stringify(disk).includes('apiKey'), false);

  const reloaded = new RouterStateStore(file);
  reloaded.load();
  assert.equal(reloaded.get('p/m')?.reason, '429');
});

test('garbage collection removes old routes missing from current OMP registry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-router-'));
  const store = new RouterStateStore(path.join(dir, 'state.json'));
  store.markCooldown('gone/model', 0, 'old', 1000);
  store.recordFailure('gone/model', 1000);
  store.recordSuccess('keep/model', 1000);
  store.garbageCollect(new Set(['keep/model']), 1000 + 25 * 60 * 60_000);
  assert.equal(store.get('gone/model'), undefined);
  assert.ok(store.get('keep/model'));
});
