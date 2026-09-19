import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeCodexBarProvider, normalizeOmpUsage, parseCodexBarRows } from '../telemetry.ts';

test('CodexBar weekly exhaustion blocks despite healthy 5h window', () => {
  const row = {
    provider: 'opencodego',
    usage: {
      primary: { usedPercent: 0, resetsAt: '2026-09-18T22:53:40Z', windowMinutes: 300 },
      secondary: { usedPercent: 100, resetsAt: '2026-09-21T00:00:00Z', windowMinutes: 10080 },
      tertiary: { usedPercent: 50, resetsAt: '2026-10-16T07:31:45Z', windowMinutes: 43200 },
    },
  };
  const normalized = normalizeCodexBarProvider(row as any, Date.parse('2026-09-18T18:00:00Z'));
  assert.equal(normalized.exhausted, true);
  assert.equal(normalized.blockedUntil, Date.parse('2026-09-21T00:00:00Z'));
});

test('CodexBar provider fetch errors are telemetry unavailable, not provider outages', () => {
  const normalized = normalizeCodexBarProvider({
    provider: 'openai',
    error: { kind: 'provider', message: 'No available fetch strategy for openai.' },
  } as any);
  assert.equal(normalized.telemetryAvailable, false);
  assert.equal(normalized.exhausted, false);
});

test('CodexBar pace can mark a provider draining before hard quota exhaustion', () => {
  const normalized = normalizeCodexBarProvider({
    provider: 'claude',
    pace: { primary: { willLastToReset: false } },
    usage: { primary: { usedPercent: 31, resetsAt: '2026-09-18T22:40:00Z' } },
  } as any);
  assert.equal(normalized.exhausted, false);
  assert.equal(normalized.draining, true);
});

test('CodexBar parses zero OpenRouter paid balance without declaring free routes unavailable', () => {
  const rows = parseCodexBarRows(JSON.parse(fs.readFileSync('fixtures/codexbar-usage.json', 'utf8')));
  const or = rows.find((x) => x.provider === 'openrouter');
  assert.ok(or);
  assert.equal(or.paidBalanceUsd, 0);
  assert.equal(or.paidBalanceKnown, true);
});

test('OMP normalization preserves multiple credentials and tier-scoped limits', () => {
  const raw = JSON.parse(fs.readFileSync('fixtures/omp-usage.json', 'utf8'));
  const reports = normalizeOmpUsage(raw);
  const codex = reports.filter((r) => r.provider === 'openai-codex');
  assert.equal(codex.length, 2);
  assert.notEqual(codex[0]?.credentialKey, codex[1]?.credentialKey);

  const anthropic = reports.find((r) => r.provider === 'anthropic');
  assert.ok(anthropic);
  const fable = anthropic.windows.find((w) => w.tier === 'fable');
  assert.ok(fable);
  assert.equal(fable.remainingFraction, 0.83);
});

test('CodexBar CLI partial JSON remains useful even when some provider rows make the command exit non-zero', async () => {
  const { parseCodexBarCliOutput } = await import('../telemetry.ts');
  const rows = parseCodexBarCliOutput({
    code: 1,
    stdout: JSON.stringify([
      { provider: 'openrouter', usage: { details: [{ title: 'Credits', rows: [{ label: 'Remaining', value: '$3.50' }] }] } },
      { provider: 'openai', error: { message: 'No available fetch strategy for openai.' } },
    ]),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'openrouter');
  assert.equal(rows[0].paidBalanceUsd, 3.5);
  assert.equal(rows[1].telemetryAvailable, false);
});

