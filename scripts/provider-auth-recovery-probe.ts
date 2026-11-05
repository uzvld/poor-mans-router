// bun scripts/provider-auth-recovery-probe.ts
// Isolated OMP lifecycle with built-in OpenAI transport and real login-key
// resolution/rotation. All credentials are synthetic; inference is loopback only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contextMarker = 'PMR_AUTH_PROBE_CONTEXT';
const root = mkdtempSync(join(tmpdir(), 'pmr-auth-probe-'));
const summaries: unknown[] = [];

try {
  for (const scenario of ['expired-only', 'healthy-sibling'] as const) {
    const work = join(root, scenario);
    const agentDir = join(work, 'agent');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(work, 'home'));
    // The probe extension refuses to seed credentials anywhere that lacks this marker.
    writeFileSync(join(work, '.pmr-auth-probe-disposable'), '');
    const requests: Array<{ provider: string; model: string; credential: string; context: boolean }> = [];
    let expiredBearer: string | undefined;
    let usageRequests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/open/v1/usage') {
          usageRequests++;
          // A usage endpoint can report quota while an inference key is expired;
          // OMP's actual opencode-go usage parser and model-health code run here.
          const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
          const window = { status: 'ok', percent: 20, resetsAt };
          return Response.json({ usage: { rolling: window, weekly: window, monthly: window } });
        }
        if (!['/open/v1/chat/completions', '/rescue/v1/chat/completions'].includes(url.pathname)) {
          return new Response('unexpected probe request', { status: 404 });
        }
        const body: unknown = await request.json();
        if (!body || typeof body !== 'object' || !('model' in body) || typeof body.model !== 'string') {
          return new Response('missing model', { status: 400 });
        }
        const isRescue = url.pathname.startsWith('/rescue/');
        const bearer = request.headers.get('authorization') ?? '';
        if (!isRescue && expiredBearer === undefined) expiredBearer = bearer;
        const credential = isRescue ? 'rescue' : bearer === expiredBearer ? 'expired' : 'healthy';
        requests.push({ provider: isRescue ? 'rescue' : 'opencode-go', model: body.model, credential,
          context: JSON.stringify(body).includes(contextMarker) });
        if (!isRescue && credential === 'expired') {
          return Response.json({ error: { message: 'This API key has expired. Create a new API key.',
            type: 'invalid_request_error', code: 'api_key_expired' } }, { status: 401 });
        }
        const chunk = (delta: Record<string, string>, finish: string | null) => JSON.stringify({
          id: 'loopback', object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        return new Response(`data: ${chunk({ role: 'assistant', content: 'RECOVERED' }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
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
  enabled: true
  maxRetries: 3
  usageAwareFallback: true
  modelFallback: true
  fallbackChains:
    default:
      - pmr-auth-rescue/fallback-basic
`);
      const child = Bun.spawn([
        process.env.OMP_BIN ?? 'omp', '--no-extensions', '-e', fileURLToPath(new URL('./provider-auth-probe-extension.ts', import.meta.url)),
        '--no-tools', '--no-skills', '--no-rules', '--no-title', '--no-session', '--mode', 'json',
        '--model', 'pmr/balanced', '--thinking', 'off', '--max-time', '25s',
        '--system-prompt', 'Complete the original user request.', '-p', `${contextMarker}: Reply RECOVERED`,
      ], {
        cwd: work, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        env: { PATH: process.env.PATH ?? '', HOME: join(work, 'home'), TMPDIR: work,
          PI_CODING_AGENT_DIR: agentDir, PMR_STATE_FILE: join(work, 'state.json'),
          PMR_AUTH_PROBE_URL: `http://127.0.0.1:${server.port}`, PMR_AUTH_PROBE_SCENARIO: scenario,
          ...(process.env.PMR_PROBE_ROUTER ? { PMR_PROBE_ROUTER: process.env.PMR_PROBE_ROUTER } : {}) },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      assert.ok(code === 0 || code === 1, `${scenario}: unexpected exit ${code}: ${stderr}`);
      assert.ok(!stderr.includes('Extension error'), stderr);
      const events: unknown[] = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      const traces: unknown[] = stderr.split('\n').filter(line => line.startsWith('PMR_AUTH_TRACE '))
        .map(line => JSON.parse(line.slice('PMR_AUTH_TRACE '.length)));
      assert.ok(requests.length > 0, `${scenario}: no inference request; ${stdout}\n${stderr}`);
      assert.ok(usageRequests > 0, `${scenario}: OMP usage-health path was not exercised`);
      assert.ok(requests.every(request => request.context), `${scenario}: original user context was lost`);
      const opencodeRequests = requests.filter(request => request.provider === 'opencode-go');
      if (scenario === 'expired-only') {
        // The only credential is dead: the sibling model must not be tried with it, and the
        // task completes on the rescue route instead of ending on a provider error.
        assert.equal(opencodeRequests.length, 1, `a sibling model was tried with the dead key: ${JSON.stringify({ requests, traces })}`);
        assert.equal(requests.at(-1)?.provider, 'rescue', `no rescue request: ${JSON.stringify({ requests, traces })}`);
        assert.equal(code, 0, `${scenario}: the task did not recover; ${stdout}\n${stderr}`);
      }
      if (scenario === 'healthy-sibling') {
        assert.equal(opencodeRequests.at(-1)?.credential, 'healthy', 'OMP must rotate to the healthy credential of the same provider');
        assert.ok(!requests.some(request => request.provider === 'rescue'), 'a usable credential must not be abandoned for the rescue route');
        assert.ok(requests.some(request => request.credential === 'healthy'),
          `healthy credential did not reach inference: ${JSON.stringify({ requests, traces })}`);
        assert.ok(events.some(event => !!event && typeof event === 'object' && 'type' in event && event.type === 'message_end'
          && 'message' in event && !!event.message && typeof event.message === 'object'
          && 'stopReason' in event.message && event.message.stopReason === 'stop'), 'healthy credential did not recover');
      }
      summaries.push({ scenario, requests, usageRequests, traces, exit: code });
    } finally {
      server.stop(true);
      // Each OMP profile extracts a native addon; release it before the next scenario.
      rmSync(work, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ transport: 'OMP built-in openai-completions', auth: 'OMP stored login-key resolver',
    usage: 'OMP opencode-go parser; synthetic loopback quota response',
    inference: 'loopback only: the extension fetch guard throws on any other host', scenarios: summaries }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
