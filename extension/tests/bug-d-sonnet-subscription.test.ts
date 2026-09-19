import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateRouteHealth } from '../health.ts';
import { normalizeOmpUsage, parseCodexBarRows } from '../telemetry.ts';

// BUG D regression: live 2026-09-19 snapshot.
// OMP anthropic#1: 5h used=1% (ok), 7d used=24% (ok), 7d:fable used=17% (ok).
// CodexBar claude pace: primary(5h).willLastToReset=true, secondary(7d).willLastToReset=false.
// Policy: fresh healthy OMP scoped capacity is authoritative; a long-window CodexBar
// burn-rate FORECAST must not convert a healthy subscription route into DRAINING.
const LIVE_NOW = Date.parse('2026-09-19T02:56:09.916Z');

function liveInputs() {
  return {
    ompReports: normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/live-omp-usage-2026-09-19.json', 'utf8'))),
    codexbar: parseCodexBarRows(JSON.parse(fs.readFileSync('fixtures/live-codexbar-2026-09-19.json', 'utf8'))),
    local: undefined,
    reservePct: 10,
    now: LIVE_NOW,
  };
}

test('BUG D: healthy OMP Sonnet 5 subscription stays AVAILABLE despite pessimistic CodexBar weekly pace', () => {
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, liveInputs());
  assert.equal(h.state, 'AVAILABLE', `expected AVAILABLE, got ${h.state} (${h.reason})`);
});

// The same pessimistic CodexBar pace, but OMP itself reports the 5h window inside
// the 10% reserve. OMP capacity is authoritative in BOTH directions: it must still demote.
function withOmpWindow(patch: Record<string, unknown>) {
  const inputs = liveInputs();
  const anthropic = inputs.ompReports.find((r) => r.provider === 'anthropic')!;
  const w = anthropic.windows.find((x) => x.id === '5h')!;
  Object.assign(w, patch);
  return inputs;
}

test('BUG D guard: OMP quota inside reserve still demotes Sonnet 5 to DRAINING', () => {
  const inputs = withOmpWindow({ usedFraction: 0.95, remainingFraction: 0.05, status: 'ok' });
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, inputs);
  assert.equal(h.state, 'DRAINING');
  assert.match(String(h.reason), /OMP quota within 10% reserve/);
});

test('BUG D guard: OMP quota exhausted still blocks Sonnet 5 with COOLDOWN until reset', () => {
  const resetsAt = LIVE_NOW + 60 * 60_000;
  const inputs = withOmpWindow({ usedFraction: 1, remainingFraction: 0, status: 'exhausted', resetsAt });
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, inputs);
  assert.equal(h.state, 'COOLDOWN');
  assert.equal(h.cooldownUntil, resetsAt);
});

// Windows are independent scopes. A healthy shared 5h + exhausted Fable-only 7d must
// block Fable and leave Sonnet untouched, regardless of what CodexBar pace forecasts.
test('BUG D guard: exhausted Fable-scoped window blocks Fable but leaves Sonnet AVAILABLE under bad pace', () => {
  const inputs = liveInputs();
  const anthropic = inputs.ompReports.find((r) => r.provider === 'anthropic')!;
  const fable = anthropic.windows.find((x) => x.tier === 'fable')!;
  Object.assign(fable, { usedFraction: 1, remainingFraction: 0, status: 'exhausted', resetsAt: LIVE_NOW + 3_600_000 });
  assert.equal(evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-fable-5', free: false }, inputs).state, 'COOLDOWN');
  assert.equal(evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, inputs).state, 'AVAILABLE');
});

// When OMP has NO report for a provider, CodexBar remains the health source and its
// pace may legitimately mark the route DRAINING. The fix must not silence that path.
test('BUG D guard: without any OMP report, CodexBar pace still drives DRAINING', () => {
  const inputs = liveInputs();
  inputs.ompReports = inputs.ompReports.filter((r) => r.provider !== 'anthropic');
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, inputs);
  assert.equal(h.state, 'DRAINING');
});
