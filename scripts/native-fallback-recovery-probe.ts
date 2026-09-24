// bun scripts/native-fallback-recovery-probe.ts
// A real OMP process and localhost transport; no live configuration or provider inference.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import adaptiveRouter from '../extension/index.ts';

const MODEL = 'qwen/qwen3.7-flash';
const CONTEXT = 'PMR_NATIVE_RECOVERY_CONTEXT';

export default function recoveryProbe(pi: ExtensionAPI): void {
  const baseUrl = process.env.PMR_PROBE_URL;
  if (!baseUrl?.startsWith('http://127.0.0.1:')) throw new Error('probe requires a localhost transport');
  for (const [provider, lane, price] of [
    ['pmr-smoke-paid', 'paid', 1],
    ['pmr-smoke-backup', 'backup', 3],
  ] as const) {
    const ids = lane === 'paid' ? [MODEL, 'qwen/qwen3.5-flash'] : [MODEL];
    pi.registerProvider(provider, {
      baseUrl: `${baseUrl}/${lane}`,
      apiKey: 'probe',
      models: ids.map((id, index) => ({
        id, name: id, api: 'openai-completions', supportsTools: true,
        contextWindow: 128000, maxTokens: 1024,
        cost: { input: price + index, output: price + index, cacheRead: 0, cacheWrite: 0 },
      })),
    }, provider);
  }
  adaptiveRouter(pi);
}

if (import.meta.main) {
  const work = mkdtempSync(join(tmpdir(), 'pmr-native-recovery-'));
  const home = join(work, 'home');
  const agentDir = join(work, 'agent');
  mkdirSync(home);
  mkdirSync(agentDir);
  const requests: Array<{ lane: string; contextPresent: boolean }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const lane = new URL(request.url).pathname.split('/')[1];
      const body = await request.text();
      requests.push({ lane, contextPresent: body.includes(CONTEXT) });
      if (lane === 'paid') {
        return Response.json({ error: {
          message: 'Add credits to continue, or switch to a free model', type: 'payment_required',
        } }, { status: 402 });
      }
      const chunks = [
        { id: 'probe', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'RECOVERED' }, finish_reason: null }] },
        { id: 'probe', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  try {
    writeFileSync(join(agentDir, 'config.yml'), `mcp:
  enableProjectConfig: false
memory:
  enabled: false
autolearn:
  enabled: false
modelRoles:
  default: pmr/balanced
retry:
  enabled: true
  maxRetries: 2
  usageAwareFallback: false
  modelFallback: true
  fallbackChains:
    default:
      - pmr-smoke-backup/${MODEL}
`);
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn([
        process.env.OMP_BIN ?? 'omp', '--no-extensions', '-e', fileURLToPath(import.meta.url),
        '--no-tools', '--no-skills', '--no-rules', '--no-title', '--no-session',
        '--model', 'pmr/balanced', '--thinking', 'off', '--max-time', '20s',
        '-p', `${CONTEXT}: Reply RECOVERED`,
      ], {
        cwd: work, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '', HOME: home, TMPDIR: work,
          PI_CODING_AGENT_DIR: agentDir, PMR_STATE_FILE: join(work, 'route-state.json'),
          PMR_PROBE_URL: `http://127.0.0.1:${server.port}`,
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, `run ${run + 1}: ${stderr}`);
      assert.match(stdout, /RECOVERED/);
    }
    assert.deepEqual(requests.map((request) => request.lane), ['paid', 'backup', 'backup']);
    assert.ok(requests.every((request) => request.contextPresent), 'native continuation must retain the user context');
    console.log(JSON.stringify({
      requests: requests.map((request) => request.lane), contextPreserved: true,
      firstRun: 'native virtual fallback recovered', secondRun: 'paid wallet avoided',
      liveProviderRequests: 0,
    }, null, 2));
  } finally {
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
}
