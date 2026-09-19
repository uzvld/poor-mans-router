import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexBarProvider } from '../telemetry.ts';
import { evaluateRouteHealth } from '../health.ts';

// CodexBar windows are not interchangeable. A window with a reset time is an
// allowance that refills (Codex 5h/weekly, Anthropic); a window without one is a
// prepaid balance that only a top-up refills (a Kilo Pass wallet). Kilo's monthly
// pass is itself a top-up with a bonus, so "pass consumed" is the normal state
// while credits remain — it must not veto the provider.
const NOW = Date.parse('2026-09-19T06:30:00Z');
const PASS_RESET = Date.parse('2026-10-17T09:22:52Z');

const kiloRow = (balanceUsedPercent: number) => ({
  provider: 'kilo',
  usage: {
    updatedAt: '2026-09-19T06:25:30Z',
    // remaining prepaid credits: no reset, only a manual top-up refills it
    primary: { usedPercent: balanceUsedPercent, resetDescription: 'credits' },
    // cumulative spend against the monthly pass allowance: resets monthly
    secondary: { usedPercent: 100, resetsAt: '2026-10-17T09:22:52Z', resetDescription: '$45.10 / $19.00 (+ $9.50 bonus)' },
    tertiary: null,
  },
});

test('a consumed monthly allowance does not veto a provider that still has prepaid credits', () => {
  const n = normalizeCodexBarProvider(kiloRow(68.69402), NOW);
  assert.equal(n.exhausted, false, 'pass spent + credits left must stay usable');
  assert.equal(n.blockedUntil, undefined, 'nothing is blocked, so nothing has a reset date');
});

test('an empty prepaid balance vetoes without claiming an allowance reset date', () => {
  const n = normalizeCodexBarProvider(kiloRow(100), NOW);
  assert.equal(n.exhausted, true);
  assert.equal(n.exhaustionScope, 'balance');
  assert.equal(n.blockedUntil, undefined, 'a top-up is manual: the allowance reset is not when this clears');
});

test('providers whose windows are all resettable allowances keep the reset-until veto', () => {
  // Codex shape: 5h window with headroom, weekly window spent. The weekly window
  // must still block until its reset — this is the BUG D / I2 territory.
  const n = normalizeCodexBarProvider(
    {
      provider: 'openai-codex',
      usage: {
        primary: { usedPercent: 20, resetsAt: '2026-09-19T11:00:00Z' },
        secondary: { usedPercent: 100, resetsAt: '2026-09-22T09:00:00Z' },
      },
    },
    NOW,
  );
  assert.equal(n.exhausted, true);
  assert.equal(n.exhaustionScope, 'allowance');
  assert.equal(n.blockedUntil, Date.parse('2026-09-22T09:00:00Z'));
});

test('route health: kilo stays available on pass-spent credits and says so truthfully when empty', () => {
  const route = { provider: 'kilo', modelId: '~anthropic/claude-sonnet-latest', free: false };
  const withCredits = evaluateRouteHealth(route, {
    ompReports: [],
    codexbar: [normalizeCodexBarProvider(kiloRow(68.69402), NOW)],
    reserveFraction: 0.1,
    now: NOW,
  });
  assert.equal(withCredits.state, 'AVAILABLE');

  const drained = evaluateRouteHealth(route, {
    ompReports: [],
    codexbar: [normalizeCodexBarProvider(kiloRow(100), NOW)],
    reserveFraction: 0.1,
    now: NOW,
  });
  assert.equal(drained.state, 'COOLDOWN');
  assert.match(drained.reason ?? '', /balance/i);
  assert.equal(drained.cooldownUntil, undefined);
  assert.notEqual(drained.cooldownUntil, PASS_RESET);
});
