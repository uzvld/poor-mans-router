// bun scripts/provider-error-recovery-probe.ts [--baseline]
// Actual OMP lifecycle, temporary profile and loopback-only transport; zero live inference.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT = 'PMR_PROVIDER_RECOVERY_CONTEXT';
const RETIREMENT = 'Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.';
const STREAM_ERROR = 'Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)';
const baseline = process.argv.includes('--baseline');
const root = mkdtempSync(join(tmpdir(), 'pmr-provider-recovery-'));
const summaries: Array<Record<string, unknown>> = [];

try {
  for (const scenario of ['retirement-partial', 'unavailable-native', 'expired-key', 'transport-partial', 'all-unavailable', 'manual', 'request-shape']) {
    const work = join(root, scenario);
    const agentDir = join(work, 'agent');
    mkdirSync(agentDir, {recursive: true});
    mkdirSync(join(work, 'home'));
    const requests: Array<{lane: string; contextPresent: boolean; partialPresent: boolean}> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const lane = new URL(request.url).pathname.slice(1);
        const body = await request.text();
        requests.push({lane, contextPresent: body.includes(CONTEXT), partialPresent: body.includes('PARTIAL_WORK')});
        if (lane !== 'primary' && scenario !== 'all-unavailable') return Response.json({text: 'RECOVERED'});
        if (scenario === 'retirement-partial' || scenario === 'manual') return Response.json({text: RETIREMENT, error: STREAM_ERROR});
        if (scenario === 'transport-partial') return Response.json({text: 'PARTIAL_WORK: an earlier step is complete.', error: STREAM_ERROR});
        if (scenario === 'expired-key') return Response.json({text: '', error: '401 This API key has expired. Create a new API key.'});
        if (scenario === 'request-shape') return Response.json({text: '', error: '400 Bad Request: invalid tool schema'});
        return Response.json({text: '', error: '400 Upstream request failed: Model is unavailable.'});
      },
    });
    try {
      // Disable unrelated control-plane features and retain native retry only where exercised.
      const native = scenario === 'unavailable-native' || scenario === 'all-unavailable' || scenario === 'expired-key';
      writeFileSync(join(agentDir, 'config.yml'), `mcp:
  enableProjectConfig: false
memory:
  backend: off
autolearn:
  enabled: false
compaction:
  enabled: false
modelRoles:
  default: pmr/balanced
retry:
  enabled: ${native}
  maxRetries: 2
  usageAwareFallback: false
  modelFallback: ${native}
  fallbackChains:
    default:
      - pmr-recovery-backup/claude-sonnet-4-6
      - pmr-recovery-third/claude-sonnet-4-6
`);
      const runs = ['retirement-partial', 'unavailable-native', 'expired-key', 'transport-partial'].includes(scenario) && !baseline ? 2 : 1;
      const observedEvents: string[] = [];
      for (let run = 0; run < runs; run++) {
        const child = Bun.spawn([
          process.env.OMP_BIN ?? 'omp', '--no-extensions', '-e', fileURLToPath(new URL('./provider-error-probe-extension.ts', import.meta.url)),
          '--no-tools', '--no-skills', '--no-rules', '--no-title', '--no-session', '--mode', 'json',
          '--model', scenario === 'manual' ? 'pmr-recovery-primary/claude-sonnet-4-6' : 'pmr/balanced',
          '--thinking', 'off', '--max-time', '15s', '--system-prompt', 'Complete the original user request.',
          '-p', `${CONTEXT}: Reply RECOVERED`,
        ], {
          cwd: work, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
          env: {PATH: process.env.PATH ?? '', HOME: join(work, 'home'), TMPDIR: work,
            PI_CODING_AGENT_DIR: agentDir, PMR_STATE_FILE: join(work, 'state.json'), PMR_PROBE_URL: `http://127.0.0.1:${server.port}`,
            ...(process.env.PMR_PROBE_ROUTER ? {PMR_PROBE_ROUTER: process.env.PMR_PROBE_ROUTER} : {})},
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        assert.ok(!stderr.includes('Extension error'), stderr);
        // Terminal error scenarios may intentionally exit nonzero; never accept a killed/hung process.
        assert.ok(code === 0 || code === 1, `${scenario}: unexpected exit ${code}: ${stderr}`);
        const events: unknown[] = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        let recovered = false;
        for (const event of events) {
          if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') continue;
          observedEvents.push(event.type);
          if (event.type === 'message_end' && 'message' in event && event.message && typeof event.message === 'object'
            && 'role' in event.message && event.message.role === 'assistant' && 'stopReason' in event.message && event.message.stopReason === 'stop'
            && 'model' in event.message && event.message.model === 'claude-sonnet-4-6'
            && 'content' in event.message && Array.isArray(event.message.content)) {
            recovered = event.message.content.some(block => block && typeof block === 'object' && block.type === 'text' && block.text === 'RECOVERED');
          }
        }
        const expectedSuccess = !baseline && !['all-unavailable', 'manual', 'request-shape'].includes(scenario) && (native || run > 0);
        assert.equal(recovered, expectedSuccess, `${scenario}: ${stdout}\n${stderr}`);
      }
      assert.ok(requests.every(request => request.contextPresent), `${scenario}: original user context lost`);
      const lanes = requests.map(request => request.lane);
      if (baseline || scenario === 'manual' || scenario === 'request-shape') {
        assert.deepEqual(lanes, ['primary'], `${scenario}: unexpected replay`);
      } else if (scenario === 'all-unavailable') {
        assert.deepEqual(lanes, ['primary', 'backup', 'third'], 'no route may be tried twice after a deterministic rejection');
      } else if (scenario === 'retirement-partial' || scenario === 'transport-partial') {
        assert.deepEqual(lanes, ['primary', 'backup'], 'the terminal failure stays terminal; a fresh attempt avoids the route');
        assert.equal(observedEvents.filter(type => type === 'agent_start').length, 2, 'no extension-owned automatic continuation');
      } else {
        assert.deepEqual(lanes, ['primary', 'backup', 'backup']);
      }
      if (scenario === 'retirement-partial' && !baseline) {
        const state = JSON.parse(readFileSync(join(work, 'state.json'), 'utf8'));
        assert.ok(state.routes['pmr-recovery-primary/claude-sonnet-4-6'].cooldownUntil > Date.now());
      }
      summaries.push({scenario, requests: lanes, nativeFallbacks: observedEvents.filter(type => type === 'retry_fallback_applied').length, contextPreserved: true});
    } finally {server.stop(true);}
    if (baseline) break;
  }
  console.log(JSON.stringify({baseline, scenarios: summaries, liveProviderRequests: 0}, null, 2));
} finally {rmSync(root, {recursive: true, force: true});}
