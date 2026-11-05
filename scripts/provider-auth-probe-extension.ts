// Loaded only by provider-auth-recovery-probe.ts in a disposable OMP profile.
// Inference uses OMP's built-in OpenAI transport and auth resolver, not streamSimple.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';

const provider = 'opencode-go';

export default async function providerAuthProbe(pi: ExtensionAPI): Promise<void> {
  const base = process.env.PMR_AUTH_PROBE_URL;
  const url = base ? new URL(base) : undefined;
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('auth probe requires an explicit loopback server');
  }

  // This extension seeds synthetic credentials into the agent database, so it must never run
  // against a real profile: only the disposable profile the driver creates inside its own TMPDIR.
  // Paths are resolved (no `..` or symlink tricks), named profiles are refused because OMP then
  // ignores PI_CODING_AGENT_DIR, and the driver's marker file must sit in TMPDIR: a real profile
  // or home directory never contains it.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const scratch = process.env.TMPDIR;
  const refuse = (reason: string): never => {
    throw new Error(`auth probe refused (${reason}); run it only through provider-auth-recovery-probe.ts`);
  };
  if (!agentDir || !scratch) refuse('PI_CODING_AGENT_DIR or TMPDIR unset');
  if (!process.env.PMR_AUTH_PROBE_SCENARIO) refuse('not started by the driver');
  if (process.env.OMP_PROFILE || process.env.PI_PROFILE) refuse('a named profile is active');
  const realAgentDir = realpathSync(agentDir!);
  const realScratch = realpathSync(scratch!);
  if (!realAgentDir.startsWith(`${realScratch}/`)) refuse('agent directory is not inside TMPDIR');
  if (!existsSync(join(realScratch, '.pmr-auth-probe-disposable'))) refuse('no driver marker in TMPDIR');

  // Fail closed if any OMP or extension fetch attempts to leave loopback. A custom
  // stream would bypass the auth-retry driver this probe is meant to examine.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== url.port) {
      throw new Error('auth probe blocked a non-loopback fetch');
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  // PMR's background telemetry helpers otherwise start separate omp/codexbar
  // processes, which do not inherit the fetch guard above. No telemetry is needed
  // for this controlled reproduction, and the parent process has no real keys.
  pi.exec = async () => ({ code: 1, killed: false, stdout: '', stderr: 'disabled in isolated auth probe' });

  pi.registerProvider(provider, {
    baseUrl: `${base}/open/v1`, api: 'openai-completions',
    // Declaring a login flow allows the real stored login-key pool to take
    // precedence. The flow is never called; credentials are seeded below.
    oauth: {
      name: 'Loopback probe',
      login: async () => { throw new Error('probe login must not run'); },
      // Force OMP to materialize and replace the built-in provider catalog
      // before registering our two local models, rather than merge lazy slices.
      modifyModels: models => models,
    },
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: false, input: ['text'],
        contextWindow: 128000, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: false, input: ['text'],
        contextWindow: 128000, maxTokens: 1024, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ],
  });
  pi.registerProvider('pmr-auth-rescue', {
    baseUrl: `${base}/rescue/v1`, api: 'openai-completions', apiKey: 'loopback-synthetic-rescue',
    models: [{ id: 'fallback-basic', name: 'Loopback rescue', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 } }],
  });

  pi.on('session_start', async (_event, ctx) => {
    const keys = process.env.PMR_AUTH_PROBE_SCENARIO === 'healthy-sibling'
      ? ['loopback-synthetic-a', 'loopback-synthetic-b'] : ['loopback-synthetic-a'];
    await ctx.modelRegistry.authStorage.credentials.set(provider, keys.map(key => ({ type: 'api_key', key, source: 'login' })));
    // Runtime provider overlays do not hide every bundled model in OMP's
    // lazy catalog. Constrain this isolated catalog; otherwise PMR can select
    // an unrelated built-in OpenCode model with its real endpoint.
    const available = ctx.modelRegistry.getAvailable.bind(ctx.modelRegistry);
    const allowed = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5.3-flash',
      'pmr/balanced', 'pmr-auth-rescue/fallback-basic'];
    ctx.modelRegistry.getAvailable = (...args) => available(...args)
      .filter(model => allowed.includes(`${model.provider}/${model.id}`));
  });

  // The override intentionally lets this harness compare another router implementation.
  const implementation = process.env.PMR_PROBE_ROUTER ?? new URL('../extension/index.ts', import.meta.url).href;
  const { default: router } = await import(implementation);
  router(pi);

  // Emit only non-secret event and credential-health metadata. AuthStorage may
  // report the currently sticky account, but that is not proof of which account
  // produced a prior retry event; the loopback server records request bearers.
  const trace = async (kind: string, event: { from?: string; to?: string; reason?: string; delayMs?: number; attempt?: number }, ctx: ExtensionContext) => {
    const auth = ctx.modelRegistry.authStorage;
    const rows = auth.credentials.list(provider);
    const model = ctx.models.current();
    const health = await auth.health.model(provider, {
      modelId: model?.provider === provider ? model.id : 'deepseek-v4.1-flash',
      sessionId: ctx.sessionManager.getSessionId(), baseUrl: `${base}/open/v1`, reserveFraction: 0.1,
    });
    const blocks = auth.blocks.list(rows.map(row => row.id));
    process.stderr.write(`PMR_AUTH_TRACE ${JSON.stringify({
      kind, from: event?.from, to: event?.to, reason: event?.reason,
      delayMs: event?.delayMs, attempt: event?.attempt,
      model: model ? `${model.provider}/${model.id}` : null,
      health: health.state,
      accounts: health.accounts.map(account => ({ id: account.credentialId, state: account.state, selected: !!account.selected })),
      blocks: blocks.map(block => ({ id: block.credentialId, scope: block.blockScope, live: block.blockedUntilMs > Date.now() })),
    })}\n`);
  };
  pi.on('retry_fallback_applied', (event, ctx) => trace('retry_fallback_applied', event, ctx));
  pi.on('auto_retry_start', (event, ctx) => trace('auto_retry_start', event, ctx));
  pi.on('before_provider_request', async (_event, ctx) => {
    const model = ctx.models.current();
    if (model && model.provider !== 'pmr') {
      const target = new URL(model.baseUrl);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== url.port) {
        ctx.abort();
        throw new Error('auth probe blocked a non-loopback model');
      }
    }
    await trace('before_provider_request', {}, ctx);
  });
  pi.on('agent_end', (_event, ctx) => trace('agent_end', {}, ctx));
}
