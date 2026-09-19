import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestSessionIdentity,
  pressureForSelection,
  allowDrainingForTier,
  FreeProbeGate,
  normalizeRuntimeSelector,
  shouldRouteBeforeAgentStart,
  retryRoutingPolicy,
} from '../runtime.ts';

test('latestSessionIdentity reads the most recent session_init agent (modelRole is gone)', () => {
  const branch: any[] = [
    { type: 'session_init', agent: 'scout', modelRole: 'smol' },
    { type: 'message', message: { role: 'user' } },
    { type: 'session_init', agent: 'reviewer', modelRole: 'plan' },
  ];
  assert.deepEqual(latestSessionIdentity(branch), { agent: 'reviewer' });
});

test('resource pressure is compact and driven by selected route health', () => {
  assert.equal(pressureForSelection(undefined), 'critical');
  assert.equal(pressureForSelection({ route: { health: { state: 'DRAINING' } } } as any), 'draining');
  assert.equal(pressureForSelection({ route: { health: { state: 'AVAILABLE' } } } as any), 'normal');
});

test('frontier is cut from degraded new work before balanced and small', () => {
  assert.equal(allowDrainingForTier('frontier'), false);
  assert.equal(allowDrainingForTier('balanced'), true);
  assert.equal(allowDrainingForTier('small'), true);
});

test('free probe gate admits at most two alternates per five-minute failure burst', () => {
  const gate = new FreeProbeGate(5 * 60_000, 2);
  const routes: any[] = [
    { key: 'a/free', free: true, health: { state: 'COOLDOWN' } },
    { key: 'b/free', free: true, health: { state: 'AVAILABLE' } },
    { key: 'c/free', free: true, health: { state: 'AVAILABLE' } },
    { key: 'd/free', free: true, health: { state: 'AVAILABLE' } },
  ];
  assert.deepEqual(gate.candidates('a/free', routes, 1000).map((r: any) => r.key), ['b/free', 'c/free']);
  assert.deepEqual(gate.candidates('a/free', routes, 2000), []);
  assert.equal(gate.candidates('a/free', routes, 1000 + 5 * 60_000 + 1).length, 2);
});

test('runtime selector normalization strips thinking suffix but preserves model variants', () => {
  assert.equal(normalizeRuntimeSelector('openai-codex/gpt-5.6-luna:auto'), 'openai-codex/gpt-5.6-luna');
  assert.equal(normalizeRuntimeSelector('openrouter/model:free'), 'openrouter/model:free');
});


test('provider retries remain owned by native OMP; adaptive routing resumes on later work', () => {
  assert.equal(shouldRouteBeforeAgentStart(false), true);
  assert.equal(shouldRouteBeforeAgentStart(true), false);
});

test('retry routing distinguishes native credential/model recovery from unhandled quota backoff', () => {
  assert.deepEqual(retryRoutingPolicy(true, 0, false), { markRouteCooldown: false, nativeOwnsContinuation: true });
  assert.deepEqual(retryRoutingPolicy(true, 0, true), { markRouteCooldown: true, nativeOwnsContinuation: true });
  assert.deepEqual(retryRoutingPolicy(true, 1500, false), { markRouteCooldown: true, nativeOwnsContinuation: true });
  assert.deepEqual(retryRoutingPolicy(false, 1500, false), { markRouteCooldown: false, nativeOwnsContinuation: true });
});
