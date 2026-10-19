// bun scripts/managed-retry-recovery-probe.ts
// Real OMP, isolated state/config and localhost transports; no live providers or credentials.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import adaptiveRouter from '../extension/index.ts';

const PRIMARY = 'pmr-stop-anthropic';
const BACKUP = 'pmr-stop-codex';
const TOOL_RESULT = 'COMPLETED_WORK_MUST_NOT_REPEAT';
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

export default async function recoveryProbe(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.PMR_STOP_URL;
  if (!baseUrl?.startsWith('http://127.0.0.1:')) throw new Error('probe requires a localhost transport');
  for (const [provider, ids] of [[PRIMARY, process.env.PMR_STOP_NO_NATIVE ? ['claude-sonnet-5-5'] : ['claude-sonnet-5-5', 'claude-sonnet-5']],
    [BACKUP, process.env.PMR_STOP_NO_BACKUP ? [] : ['gpt-6-luna']]] as const) {
    if (!ids.length) continue;
    pi.registerProvider(provider, { baseUrl: `${baseUrl}/${provider}`, apiKey: 'probe',
      models: ids.map(id => ({ id, name: id, api: 'openai-completions', supportsTools: true,
        contextWindow: 128000, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })),
    }, provider);
  }
  pi.registerTool({ name: 'record_completed_work', label: 'Record completed work', description: 'Probe-only completed action',
    parameters: pi.typebox.Type.Object({}),
    async execute() {
      appendFileSync(process.env.PMR_STOP_ACTIONS!, 'completed\n');
      return { content: [{ type: 'text', text: TOOL_RESULT }], details: {} };
    },
  });
  pi.on('session_start', () => { pi.setActiveTools(['record_completed_work']); });
  let status: Command['handler'] | undefined;
  // Disable optional telemetry timers, not routing/retry logic. The scratch snapshot supplies capacity.
  const on: ExtensionAPI['on'] = (name, handler) => pi.on(name, (event, ctx) => {
    if (name === 'retry_fallback_applied' || name === 'session_stop') {
      appendFileSync(process.env.PMR_STOP_EVENTS!, JSON.stringify({ type: name }) + '\n');
    }
    return handler(event, new Proxy(ctx, {
      get(target, property) {
        if (property === 'setTimeout' || property === 'setInterval') return () => undefined;
        return Reflect.get(target, property);
      },
    }));
  });
  const registerCommand: ExtensionAPI['registerCommand'] = (name, command) => {
    if (name === 'route-status') status = command.handler;
    pi.registerCommand(name, command);
  };
  // The optional path selects the installed copy for the same post-deployment proof.
  const router = process.env.PMR_STOP_ROUTER ? (await import(process.env.PMR_STOP_ROUTER)).default : adaptiveRouter;
  router(new Proxy(pi, { get(target, property) {
    if (property === 'on') return on;
    if (property === 'registerCommand') return registerCommand;
    return Reflect.get(target, property);
  } }));
  pi.on('before_provider_request', async (_event, ctx) => {
    const latestModel = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'model_change');
    if (latestModel?.type === 'model_change') appendFileSync(process.env.PMR_STOP_EVENTS!,
      JSON.stringify({ type: 'provider_request', model: latestModel.model, role: latestModel.role,
        resolvedModelIsFallback: latestModel.resolvedModelIsFallback }) + '\n');
    if (!status) throw new Error('route-status was not registered');
    await status('', { ...ctx, ui: { ...ctx.ui, notify(text: string) {
      appendFileSync(process.env.PMR_STOP_STATUS!, text + '\n\n');
    } } });
  });
}

if (import.meta.main) {
  const work = mkdtempSync(join(tmpdir(), 'pmr-managed-recovery-'));
  const requests: Array<{ scenario: string; provider: string; model: string; taskPresent: boolean; completedWorkPresent: boolean }> = [];
  let scenario = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const provider = new URL(request.url).pathname.split('/')[1];
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('model' in body) || typeof body.model !== 'string' || !('messages' in body)) {
      return new Response('bad probe payload', { status: 400 });
    }
    const messages = JSON.stringify(body.messages);
    const completedWorkPresent = messages.includes(TOOL_RESULT);
    requests.push({ scenario, provider, model: body.model, taskPresent: messages.includes('PMR_MANAGED_TASK'), completedWorkPresent });
    if (provider === PRIMARY && completedWorkPresent) {
      return Response.json({ error: { type: 'rate_limit_error', message: 'This request would exceed your account rate limit' } },
        { status: 429, headers: { 'Retry-After': '13843' } });
    }
    const delta = provider === PRIMARY
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_completed_work', type: 'function',
          function: { name: 'record_completed_work', arguments: '{}' } }] }
      : { role: 'assistant', content: 'MANAGED_RECOVERY_COMPLETE' };
    const chunks = [{ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: provider === PRIMARY ? 'tool_calls' : 'stop' }] }];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const reports: Array<{ scenario: string; code: number; answered: boolean; completedActions: number;
    requests: typeof requests; events: Array<{ type: string; model?: string; role?: string }>; status: string; errorTail: string }> = [];
  try {
    for (scenario of ['managed-chain', 'managed-no-chain', 'manual-chain', 'managed-no-alternative']) {
      const root = join(work, scenario); const home = join(root, 'home'); const agent = join(root, 'agent');
      mkdirSync(home, { recursive: true }); mkdirSync(agent);
      const fallbacks = scenario === 'managed-no-chain' ? '[]' : `\n      - ${PRIMARY}/claude-sonnet-5`;
      writeFileSync(join(agent, 'config.yml'), `mcp:\n  enableProjectConfig: false\nmemory:\n  enabled: false\nautolearn:\n  enabled: false\ncompaction:\n  enabled: false\nmodelRoles:\n  default: pmr/balanced\nretry:\n  enabled: true\n  maxRetries: 3\n  maxDelayMs: 1000\n  modelFallback: true\n  usageAwareFallback: false\n  waitForUsageReset: false\n  fallbackChains:\n    default: ${fallbacks}\n    '${PRIMARY}/*': ${fallbacks}\n`);
      writeFileSync(join(root, 'state.json'), JSON.stringify({ routes: {}, telemetry: { fetchedAt: Date.now(), codexbar: [],
        ompReports: [PRIMARY, BACKUP].map(provider => ({ provider, credentialKey: `${provider}#1`, fetchedAt: Date.now(),
          windows: [{ id: '5h', shared: true, remainingFraction: 0.8, status: 'ok', resetsAt: Date.now() + 18000000 }] })) } }));
      writeFileSync(join(root, 'actions.txt'), ''); writeFileSync(join(root, 'route-status.txt'), '');
      writeFileSync(join(root, 'events.jsonl'), '');
      const p = Bun.spawn([process.env.OMP_BIN ?? 'omp', '--no-extensions', '-e', fileURLToPath(import.meta.url),
        '--no-tools', '--no-skills', '--no-rules', '--no-title', '--no-session',
        '--model', scenario === 'manual-chain' ? `${PRIMARY}/claude-sonnet-5-5` : 'pmr/balanced',
        '--thinking', 'off', '--max-time', '30s', '-p', 'PMR_MANAGED_TASK: Use record_completed_work once, then complete the task.'], {
        cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 40000,
        env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: root, PI_CODING_AGENT_DIR: agent,
          PMR_STATE_FILE: join(root, 'state.json'), PMR_STOP_URL: `http://127.0.0.1:${server.port}`,
          PMR_STOP_ROUTER: process.env.PMR_STOP_ROUTER ?? '', PMR_STOP_ACTIONS: join(root, 'actions.txt'),
          PMR_STOP_STATUS: join(root, 'route-status.txt'), PMR_STOP_EVENTS: join(root, 'events.jsonl'),
          PMR_STOP_NO_NATIVE: scenario === 'managed-no-chain' ? '1' : '',
          PMR_STOP_NO_BACKUP: scenario === 'managed-no-alternative' ? '1' : '' },
      });
      const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      reports.push({ scenario, code, answered: stdout.includes('MANAGED_RECOVERY_COMPLETE'),
        completedActions: readFileSync(join(root, 'actions.txt'), 'utf8').split('\n').filter(Boolean).length,
        requests: requests.filter(r => r.scenario === scenario), status: readFileSync(join(root, 'route-status.txt'), 'utf8'),
        events: readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
        errorTail: (stdout + stderr).slice(-400) });
    }
    const report = { reports, liveProviderRequests: 0 };
    if (process.env.PMR_PROBE_OUTPUT) writeFileSync(process.env.PMR_PROBE_OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reports: reports.map(({ status: _status, ...r }) => r), liveProviderRequests: 0 }, null, 2));
    for (const r of reports) {
      const managedRecovery = r.scenario === 'managed-chain' || r.scenario === 'managed-no-chain';
      assert.equal(r.answered, managedRecovery, r.scenario);
      assert.equal(r.code, managedRecovery ? 0 : 1, r.scenario);
      assert.equal(r.completedActions, 1, 'completed tool work must never be replayed');
      const backup = r.requests.find(request => request.provider === BACKUP);
      assert.equal(!!backup, managedRecovery, 'only managed recovery may request the backup');
      if (backup) assert.ok(backup.taskPresent && backup.completedWorkPresent, 'the original task and completed work must reach the new provider');
      if (managedRecovery) {
        assert.ok(r.events.some(event => event.type === 'session_stop'), 'the native stop hook must exercise recovery');
        const switched = r.events.findLast(event => event.type === 'provider_request');
        assert.notEqual(switched?.role, 'fallback', 'PMR switches must not masquerade as native fallback provenance');
      }
      if (r.scenario === 'managed-no-chain') {
        assert.equal(r.events.filter(event => event.type === 'retry_fallback_applied').length, 0, 'no native fallback must be available');
      }
    }
  } finally { server.stop(true); rmSync(work, { recursive: true, force: true }); }
}
