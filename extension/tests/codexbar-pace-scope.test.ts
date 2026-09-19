import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexBarProvider } from '../telemetry.ts';
import { evaluateRouteHealth } from '../health.ts';

// FOLLOWUP-T1. A pace forecast answers "will this window last to its reset?", so it
// only means something for the window that actually carries capacity — the same rule
// the exhaustion path already follows: the prepaid balance when the provider has one,
// otherwise the refilling allowances.
const NOW = Date.parse('2026-09-19T07:00:00Z');

const kiloRow = (pace: Record<string, { willLastToReset: boolean }>) => ({
  provider: 'kilo',
  usage: {
    primary: { usedPercent: 40, resetDescription: 'credits' },
    secondary: { usedPercent: 100, resetsAt: '2026-10-17T09:22:52Z' },
  },
  pace,
});

test('pace on a spent allowance does not drain a provider whose balance carries the capacity', () => {
  const n = normalizeCodexBarProvider(kiloRow({
    primary: { willLastToReset: true },
    secondary: { willLastToReset: false },
  }), NOW);
  assert.equal(n.draining, false, 'the monthly pass is accounting; its pace is not the provider running dry');
});

test('pace on the prepaid balance drains, and says which window forecast it', () => {
  const n = normalizeCodexBarProvider(kiloRow({ primary: { willLastToReset: false } }), NOW);
  assert.equal(n.draining, true);
  assert.equal(n.drainingScope, 'balance');
});

test('for providers whose windows are all allowances, any spent-pace window still drains', () => {
  // Codex shape: 5h window fine, weekly window forecast to run out. Both are capacity.
  const n = normalizeCodexBarProvider({
    provider: 'openai-codex',
    usage: {
      primary: { usedPercent: 10, resetsAt: '2026-09-19T11:00:00Z' },
      secondary: { usedPercent: 60, resetsAt: '2026-09-22T09:00:00Z' },
    },
    pace: { primary: { willLastToReset: true }, secondary: { willLastToReset: false } },
  }, NOW);
  assert.equal(n.draining, true);
  assert.equal(n.drainingScope, 'allowance');
});

test('route health reports the pace scope it acted on', () => {
  const route = { provider: 'kilo', modelId: '~deepseek/deepseek-pro-latest', free: false };
  const drained = evaluateRouteHealth(route, {
    ompReports: [],
    codexbar: [normalizeCodexBarProvider(kiloRow({ primary: { willLastToReset: false } }), NOW)],
    reserveFraction: 0.1,
    now: NOW,
  });
  assert.equal(drained.state, 'DRAINING');
  assert.match(drained.reason ?? '', /balance/i);

  const calm = evaluateRouteHealth(route, {
    ompReports: [],
    codexbar: [normalizeCodexBarProvider(kiloRow({
      primary: { willLastToReset: true },
      secondary: { willLastToReset: false },
    }), NOW)],
    reserveFraction: 0.1,
    now: NOW,
  });
  assert.equal(calm.state, 'AVAILABLE');
});
