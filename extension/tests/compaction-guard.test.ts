import test from 'node:test';
import assert from 'node:assert/strict';
import { holdForRemoteCompaction, isResponsesApi, newestCompactionMethod } from '../compaction-guard.ts';
import adaptiveRouter from '../index.ts';

// BUG C (docs/investigations/bug-c-context-loss-root-cause.md): a `remote` compaction keeps
// the conversation provider-side and leaves a ~933-char placeholder in the session. OMP
// replays the provider-native items only for the same provider on a Responses API; every
// other target sees the placeholder — 1,832 messages became one sentence in the real
// session. The router must not be the thing that triggers that.

const codex = { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses' };
const codexSibling = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' };
const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', api: 'anthropic-messages' };

const remote = { type: 'compaction', method: 'remote' };
const snapcompact = { type: 'compaction', method: 'snapcompact' };

test('a switch off the Responses provider that owns a remote compaction is held', () => {
  const decision = holdForRemoteCompaction([{ type: 'session_init' }, remote], codex, sonnet);
  assert.equal(decision.hold, true);
  assert.match(String(decision.reason), /Responses API/);
});

test('a switch within the same provider on a Responses API still replays, so it proceeds', () => {
  assert.equal(holdForRemoteCompaction([remote], codex, codexSibling).hold, false);
});

test('a later portable compaction releases the hold', () => {
  // Newest wins: `snapcompact` writes a real summary, which any provider can consume.
  assert.equal(holdForRemoteCompaction([remote, snapcompact], codex, sonnet).hold, false);
  assert.equal(newestCompactionMethod([remote, snapcompact]), 'snapcompact');
});

test('an older portable compaction does not release a newer remote one', () => {
  assert.equal(holdForRemoteCompaction([snapcompact, remote], codex, sonnet).hold, true);
});

test('nothing is held when the session never compacted remotely', () => {
  assert.equal(holdForRemoteCompaction([snapcompact], codex, sonnet).hold, false);
  assert.equal(holdForRemoteCompaction([{ type: 'session_init' }], codex, sonnet).hold, false);
  assert.equal(holdForRemoteCompaction(undefined, codex, sonnet).hold, false);
});

test('a non-Responses current model has no provider-native history to strand', () => {
  // Remote compaction cannot have come from this model, so the switch is safe.
  assert.equal(holdForRemoteCompaction([remote], sonnet, codex).hold, false);
});

test('the guard fails open when the host reports no api field', () => {
  // Missing metadata must route normally: a guard that blocks on unknowns is worse
  // than the bug it prevents.
  assert.equal(isResponsesApi({ provider: 'openai-codex', id: 'x' }), false);
  assert.equal(holdForRemoteCompaction([remote], { provider: 'openai-codex', id: 'x' }, sonnet).hold, false);
});

test('before_agent_start does not call setModel while a remote compaction is stranded', async () => {
  // End-to-end through the real hook. Turn 1: only the Responses model exists, so the
  // router bootstraps the session onto it and owns the selection (managed mode). Turn 2:
  // a remote compaction now sits in the branch and a better route appears — the switch
  // the router would otherwise make is exactly the one that destroys the context.
  const handlers = new Map<string, Function[]>();
  const setModelCalls: any[] = [];
  const notices: string[] = [];
  const balanced = { provider: 'pmr', id: 'balanced', cost: {} };
  const models: any[] = [balanced, codex];
  let branch: any[] = [{ type: 'session_init' }];
  let current: any = balanced;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(model: any) { setModelCalls.push(model); return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify: (message: string) => notices.push(message) },
  };
  adaptiveRouter(pi);
  for (const handler of handlers.get('session_start')!) await handler({}, ctx);
  for (const handler of handlers.get('before_agent_start')!) await handler({}, ctx);
  assert.deepEqual(
    setModelCalls.map((model) => `${model.provider}/${model.id}`),
    [`${codex.provider}/${codex.id}`],
    'precondition: the router bootstrapped the session onto the Responses model',
  );

  current = codex;
  branch = [{ type: 'session_init' }, remote];
  models.push(sonnet);
  setModelCalls.length = 0;
  notices.length = 0;
  for (const handler of handlers.get('before_agent_start')!) await handler({}, ctx);

  assert.equal(setModelCalls.length, 0, `held switch must not call setModel, got ${JSON.stringify(setModelCalls)}`);
  assert.ok(
    notices.some((message) => message.startsWith('[omp:pmr] switch held:')),
    `expected a held-switch notice, got ${JSON.stringify(notices)}`,
  );
});
