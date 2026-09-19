import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateRouteHealth, isPermanentModelError } from '../health.ts';
import { normalizeOmpUsage, parseCodexBarRows } from '../telemetry.ts';

test('all exhausted subscription credentials cooldown only until earliest credential becomes usable', () => {
  const reports = normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/omp-usage.json', 'utf8')))
    .filter((x) => x.provider === 'openai-codex');
  const resets = reports.flatMap((x) => x.windows.map((w) => w.resetsAt).filter((x): x is number => !!x));
  const h = evaluateRouteHealth({ provider: 'openai-codex', modelId: 'gpt-5.6-luna', free: false }, {
    ompReports: reports,
    codexbar: [],
    local: undefined,
    reservePct: 10,
    now: 1789754000000,
  });
  assert.equal(h.state, 'COOLDOWN');
  assert.equal(h.cooldownUntil, Math.min(...resets));
});

test('one healthy credential keeps a provider route available', () => {
  const reports = [
    { provider: 'p', credentialKey: 'p#1', fetchedAt: 1, windows: [
      { id: '7d', shared: true, remainingFraction: 0, resetsAt: 2000, status: 'exhausted' },
    ] },
    { provider: 'p', credentialKey: 'p#2', fetchedAt: 1, windows: [
      { id: '7d', shared: true, remainingFraction: 0.8, resetsAt: 3000, status: 'ok' },
    ] },
  ];
  const h = evaluateRouteHealth({ provider: 'p', modelId: 'm', free: false }, {
    ompReports: reports as any,
    codexbar: [], local: undefined, reservePct: 10, now: 1000,
  });
  assert.equal(h.state, 'AVAILABLE');
});

test('Fable scoped quota affects Fable but not Sonnet', () => {
  const report: any = {
    provider: 'anthropic', credentialKey: 'a#1', fetchedAt: 1, windows: [
      { id: '7d', shared: true, remainingFraction: 0.8, resetsAt: 9000, status: 'ok' },
      { id: '7d', shared: false, tier: 'fable', remainingFraction: 0, resetsAt: 8000, status: 'exhausted' },
    ],
  };
  const common = { ompReports: [report], codexbar: [], local: undefined, reservePct: 10, now: 1000 };
  assert.equal(evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-fable-5', free: false }, common).state, 'COOLDOWN');
  assert.equal(evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, common).state, 'AVAILABLE');
});

test('CodexBar bad pace does not demote a subscription that OMP reports healthy', () => {
  // Policy (BUG D): OMP scoped capacity is authoritative. CodexBar pace is a burn-rate
  // forecast and may drive pressure/admission, but not route health, while OMP says ok.
  const codexbar = parseCodexBarRows(JSON.parse(fs.readFileSync('fixtures/codexbar-usage.json', 'utf8')));
  const ompReports = normalizeOmpUsage(JSON.parse(fs.readFileSync('fixtures/omp-usage.json', 'utf8')));
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, {
    ompReports, codexbar, local: undefined, reservePct: 10, now: 1789754000000,
  });
  assert.equal(h.state, 'AVAILABLE');
});

test('zero OpenRouter paid balance blocks paid route but not free route', () => {
  const codexbar = parseCodexBarRows(JSON.parse(fs.readFileSync('fixtures/codexbar-usage.json', 'utf8')));
  const input = { ompReports: [], codexbar, local: undefined, reservePct: 10, now: 1789754000000 };
  assert.equal(evaluateRouteHealth({ provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash', free: false }, input).state, 'COOLDOWN');
  assert.notEqual(evaluateRouteHealth({ provider: 'openrouter', modelId: 'nvidia/x:free', free: true }, input).state, 'COOLDOWN');
});

test('local runtime cooldown is a hard veto even when usage telemetry is healthy', () => {
  const h = evaluateRouteHealth({ provider: 'p', modelId: 'm', free: false }, {
    ompReports: [], codexbar: [], reservePct: 10, now: 1000,
    local: { cooldownUntil: 5000, reason: '429 Retry-After' },
  });
  assert.equal(h.state, 'COOLDOWN');
  assert.equal(h.cooldownUntil, 5000);
});

test('runtime cooldown honors retry timing stated in the error text when OMP switched immediately', async () => {
  const { cooldownFromRetry } = await import('../health.ts');
  const h = cooldownFromRetry('429 rate limit exceeded; retry after 120 seconds', 0, 1000);
  assert.equal(h?.cooldownUntil, 121000);
});

// Kilo's gateway quotes the full model id between "model" and "does not exist". Ids are
// arbitrary length: `bytedance-seed/dola-seed-2.0-pro:free` put 41 chars in that gap and
// slipped past a 40-char bound live (2026-09-19 15:08, six identical 404s, no cooldown).
test('a "model does not exist" rejection is permanent regardless of how long the quoted model id is', () => {
  for (const id of ['arcee-ai/trinity-large-preview:free', 'bytedance-seed/dola-seed-2.0-pro:free', 'x-ai/grok-code-fast-1:optimized:free', 'a'.repeat(120)]) {
    const message = `404 The requested model '${id}' does not exist. Please use an exact model id as listed on /api/gateway/models.`;
    assert.ok(isPermanentModelError(message), `not classified as permanent for id length ${id.length}`);
  }
  assert.ok(!isPermanentModelError('429 rate limit exceeded, retry after 30s'));
  assert.ok(!isPermanentModelError('400 Bad Request: messages must not be empty'));
});
