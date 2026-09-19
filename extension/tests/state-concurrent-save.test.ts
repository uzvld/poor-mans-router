import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterStateStore } from '../state.ts';

// state.json is shared by every OMP process on the machine: the fresh process Multica spawns
// per attempt AND any long-lived interactive session that happens to be open. Each process
// loads the file once at session_start and writes its whole in-memory routes map back on
// every agent_end. Without a merge, a long-lived session's next save silently erases the
// cooldown a short-lived process just recorded, and the dead route is re-selected as if it
// had never failed (live 2026-09-19: no trinity entry at all in state.json despite 50
// logged 404s, while the file was being rewritten every few minutes by unrelated sessions).

function tmpStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-state-')), 'state.json');
}

test('a stale process saving its own routes does not erase a cooldown another process persisted', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, JSON.stringify({ routes: {} }));

  const longLived = new RouterStateStore(file);
  longLived.load();

  const shortLived = new RouterStateStore(file);
  shortLived.load();
  const cooldownUntil = Date.now() + 15 * 60_000;
  shortLived.markCooldown('kilo/dead:free', cooldownUntil, 'model does not exist');
  shortLived.save();

  longLived.recordSuccess('anthropic/claude-sonnet-5');
  longLived.save();

  const reloaded = new RouterStateStore(file);
  reloaded.load();
  assert.equal(reloaded.get('kilo/dead:free')?.cooldownUntil, cooldownUntil, 'cooldown written by the other process was erased');
  assert.ok(reloaded.get('anthropic/claude-sonnet-5')?.lastSuccessAt, 'own write must still land');
});

test('the newer per-route record wins when two processes wrote the same route', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, JSON.stringify({ routes: {} }));

  const a = new RouterStateStore(file);
  a.load();
  const b = new RouterStateStore(file);
  b.load();

  const t0 = 1_000_000;
  a.recordSuccess('kilo/x:free', t0);
  a.save();
  b.markCooldown('kilo/x:free', t0 + 60_000, 'later failure', t0 + 1);
  b.save();
  // a's in-memory view is older than what b persisted; a must not roll the route back.
  a.recordSuccess('other/y', t0 + 2);
  a.save();

  const reloaded = new RouterStateStore(file);
  reloaded.load();
  assert.equal(reloaded.get('kilo/x:free')?.cooldownUntil, t0 + 60_000);
});
