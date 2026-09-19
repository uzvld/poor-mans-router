# Virtual-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace guessed-tier activation with explicit opt-in via three virtual models `router/frontier|balanced|small`; manual selection of any concrete model permanently opts the session out.

**Architecture:** The extension registers a fake provider `router` with three static models (`pi.registerProvider`). A per-session in-memory `RoutingMode` state machine derives mode purely from `ctx.models.current()`: a `router/*` model enters managed mode, a concrete model that is neither `router/*` nor the router's own last selection flips to `manual` forever. Managed turns run the existing ladder; a `before_provider_request` guard calls `ctx.abort()` if a request ever targets the fake provider.

**Tech Stack:** TypeScript (Bun, no build), `bun test` (node:test + assert/strict), OMP 18.2.6 ExtensionAPI.

**Spec:** `docs/spec-virtual-model-routing.md` (approved by the human partner with «делай»). Verified platform facts F1–F7 live in the spec §1; this plan cites them by number.

## Global Constraints

- Runtime: Bun; tests: `cd ~/Projects/poor-mans-router/extension && ln -sfn ../fixtures fixtures && bun test`. No build step; OMP loads `.ts` directly.
- Invariants I1–I12 in `AGENTS.md` are absolute; the ladder/comparator (`ranking.ts`, `health.ts`) must NOT change.
- I11: the extension only calls `pi.setModel` (plus the new `pi.registerProvider`, which creates no session/branch).
- I12: the placeholder `apiKey` is the literal constant `not-a-real-credential` — never a secret, never read from disk.
- Test style: `node:test` + `node:assert/strict`, one behaviour per test, harness functions mirroring `extension/tests/switch-marker.test.ts`.
- Commit after every task; conventional-commit messages (`feat:`/`refactor:`/`test:`/`docs:`).
- The uncommitted BUG C work (`announceSwitch`/`switchMarker`, `extension/tests/switch-marker.test.ts`) must be preserved and committed as Task 1.
- `tierForRole`/`tierForSession`/`agentTiers` keep existing for `policy.test.ts` compatibility ONLY until Task 5 deletes them together with their tests — never leave dead exports.
- Deploy: after all tasks, install with `scripts/install.sh` (single-writer; never two installs at once), then one live `omp` session + `/route-status`.

---

### Task 1: Commit the pending BUG C switch-marker work

**Files:**
- Modify (commit only): `extension/index.ts`, `extension/runtime.ts`, `extension/tests/switch-marker.test.ts`

**Interfaces:**
- Produces: `switchMarker(from: string, to: string, reason?: string): string` (runtime.ts:38) and `announceSwitch(ctx, from, to, reason?)` closure in `index.ts` — used unchanged by later tasks.

- [ ] **Step 1: Verify suite green with pending changes**

Run: `cd ~/Projects/poor-mans-router/extension && bun test`
Expected: 69 pass, 0 fail (includes `switch-marker.test.ts`).

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/index.ts extension/runtime.ts extension/tests/switch-marker.test.ts
git commit -m "router: announce managed model switches via [omp:router] markers (roadmap #3)"
```

### Task 2: `RoutingMode` module — pure state machine + virtual selector helpers

**Files:**
- Create: `extension/virtual-model.ts`
- Test: `extension/tests/virtual-model.test.ts`

**Interfaces:**
- Produces:
  - `export type RoutingMode = 'manual' | 'frontier' | 'balanced' | 'small'`
  - `export const VIRTUAL_PROVIDER = 'router'`
  - `export const VIRTUAL_MODELS: ReadonlyArray<{ id: 'frontier' | 'balanced' | 'small'; name: string }>`
  - `export function virtualModeForModelKey(key: string | undefined): 'frontier' | 'balanced' | 'small' | undefined` — `'frontier' | 'balanced' | 'small'` iff `key` is `router/frontier|balanced|small`, else `undefined`.
  - `export function resolveModeTransition(current: RoutingMode, currentKey: string | undefined, lastRouterSelected: string | undefined): RoutingMode` — pure function implementing the spec §3 table:
    - `virtualModeForModelKey(currentKey)` non-undefined → that mode;
    - else if `current` is a managed mode and `currentKey === lastRouterSelected` → `current` (our own switch);
    - else if `current` is a managed mode → `'manual'`;
    - else (`manual`) → `'manual'`.
  - `export const PLACEHOLDER_API_KEY = 'not-a-real-credential'`
  - `export function registerVirtualRouterProvider(pi: unknown): void` — casts through a minimal structural interface and calls `pi.registerProvider('router', {…}, 'adaptive-router')` with the exact config from spec §2 (`baseUrl: 'http://127.0.0.1:9'`, `apiKey: PLACEHOLDER_API_KEY`, three models with `api: 'openai-completions'`, `supportsTools: true`).

- [ ] **Step 1: Write the failing tests**

```ts
// extension/tests/virtual-model.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_MODELS,
  PLACEHOLDER_API_KEY,
  virtualModeForModelKey,
  resolveModeTransition,
  registerVirtualRouterProvider,
} from '../virtual-model.ts';

test('virtual selector keys map to their routing modes', () => {
  assert.equal(virtualModeForModelKey('router/frontier'), 'frontier');
  assert.equal(virtualModeForModelKey('router/balanced'), 'balanced');
  assert.equal(virtualModeForModelKey('router/small'), 'small');
  assert.equal(virtualModeForModelKey('anthropic/claude-sonnet-5'), undefined);
  assert.equal(virtualModeForModelKey(undefined), undefined);
  assert.equal(virtualModeForModelKey('router/friendly'), undefined);
});

test('a router/* selection enters managed mode from any state', () => {
  assert.equal(resolveModeTransition('manual', 'router/balanced', undefined), 'balanced');
  assert.equal(resolveModeTransition('balanced', 'router/frontier', 'kilo/m1'), 'frontier');
});

test('our own router switch keeps managed mode', () => {
  assert.equal(resolveModeTransition('balanced', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5'), 'balanced');
  assert.equal(resolveModeTransition('small', 'kilo/deepseek:free', 'kilo/deepseek:free'), 'small');
});

test('any other concrete model flips managed mode to manual', () => {
  assert.equal(resolveModeTransition('balanced', 'anthropic/claude-sonnet-5', 'kilo/m1'), 'manual');
  assert.equal(resolveModeTransition('frontier', 'kilo/m1', undefined), 'manual');
});

test('manual mode never re-activates except through a router/* selection', () => {
  assert.equal(resolveModeTransition('manual', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5'), 'manual');
  assert.equal(resolveModeTransition('manual', 'anthropic/claude-sonnet-5', undefined), 'manual');
});

test('provider registration passes the fail-closed config and three models', () => {
  const calls: Array<{ name: string; config: Record<string, unknown>; sourceId: string }> = [];
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>, sourceId: string) {
      calls.push({ name, config, sourceId });
    },
  };
  registerVirtualRouterProvider(pi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, VIRTUAL_PROVIDER);
  assert.equal(calls[0].sourceId, 'adaptive-router');
  assert.equal(calls[0].config.baseUrl, 'http://127.0.0.1:9');
  assert.equal(calls[0].config.apiKey, PLACEHOLDER_API_KEY);
  assert.equal(PLACEHOLDER_API_KEY.includes('sk-'), false, 'placeholder must never look like a credential');
  const models = calls[0].config.models as Array<{ id: string; api: string; supportsTools: boolean }>;
  assert.deepEqual(models.map((m) => m.id), ['frontier', 'balanced', 'small']);
  for (const m of models) {
    assert.equal(m.api, 'openai-completions');
    assert.equal(m.supportsTools, true);
  }
  assert.deepEqual(VIRTUAL_MODELS.map((m) => m.id), ['frontier', 'balanced', 'small']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/virtual-model.test.ts`
Expected: FAIL — `Cannot find module '../virtual-model.ts'` (6 failing tests).

- [ ] **Step 3: Write the module**

```ts
// extension/virtual-model.ts
/**
 * Virtual `router/*` models: the only opt-in surface for managed routing.
 * See docs/spec-virtual-model-routing.md §2–§3.
 *
 * The registered provider is intentionally fake: baseUrl is the TCP discard
 * port and must never be contacted. A request reaching it means the router
 * failed to switch away — the before_provider_request guard in index.ts
 * aborts the turn (spec §4) instead of burning OMP's 10 auto-retries.
 */

export type RoutingMode = 'manual' | 'frontier' | 'balanced' | 'small';

export const VIRTUAL_PROVIDER = 'router';

export const PLACEHOLDER_API_KEY = 'not-a-real-credential';

export const VIRTUAL_MODELS = [
  { id: 'frontier', name: 'Router: Frontier' },
  { id: 'balanced', name: 'Router: Balanced' },
  { id: 'small', name: 'Router: Small' },
] as const;

export type ManagedMode = Exclude<RoutingMode, 'manual'>;

export function virtualModeForModelKey(key: string | undefined): ManagedMode | undefined {
  if (typeof key !== 'string' || !key.startsWith(`${VIRTUAL_PROVIDER}/`)) return undefined;
  const id = key.slice(VIRTUAL_PROVIDER.length + 1);
  if (id === 'frontier' || id === 'balanced' || id === 'small') return id;
  return undefined;
}

export function resolveModeTransition(
  current: RoutingMode,
  currentKey: string | undefined,
  lastRouterSelected: string | undefined,
): RoutingMode {
  const managed = virtualModeForModelKey(currentKey);
  if (managed) return managed;
  if (current !== 'manual' && currentKey !== undefined && currentKey === lastRouterSelected) return current;
  return 'manual';
}

interface RegisterProviderLike {
  registerProvider(name: string, config: Record<string, unknown>, sourceId: string): void;
}

export function registerVirtualRouterProvider(pi: unknown): void {
  const api = pi as RegisterProviderLike;
  api.registerProvider(
    VIRTUAL_PROVIDER,
    {
      name: 'Router (adaptive)',
      // Discard port: never contacted. If a request reaches it, the guard aborts.
      baseUrl: 'http://127.0.0.1:9',
      // OMP 18.2.6 runtime-register validation requires an apiKey when static
      // models are defined (spec §1 fact F2). This is a constant, not a secret.
      apiKey: PLACEHOLDER_API_KEY,
      models: VIRTUAL_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        api: 'openai-completions',
        supportsTools: true,
      })),
    },
    'adaptive-router',
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/virtual-model.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/virtual-model.ts extension/tests/virtual-model.test.ts
git commit -m "feat: routing-mode state machine and virtual router/* provider registration"
```

### Task 3: Wire the state machine into `before_agent_start` (managed-only routing)

**Files:**
- Modify: `extension/index.ts`
- Test: `extension/tests/managed-mode.test.ts`

**Interfaces:**
- Consumes: `resolveModeTransition`, `virtualModeForModelKey`, `RoutingMode` from `./virtual-model.ts`; existing `modelKey()` (index.ts:49), `announceSwitch()` (index.ts:203), `chooseForCurrentWork(ctx)` (index.ts:164, unchanged), `pressureForSelection`/`pressureMessage` (unchanged).
- Produces: `before_agent_start` behaviour — returns `undefined` immediately when mode is `manual` (no telemetry refresh, no selection); in managed mode `lastRouterSelected` is set to `selection.route.key` after a successful `pi.setModel`, and NOT set when the switch fails (a failed switch must not trick the next turn into managed mode).
- Preserves: `chooseForCurrentWork` still computes `tier` via `tierForSession` internally — replaced in Task 5 by `mode`; do NOT rewrite it here.

- [ ] **Step 1: Write the failing tests**

```ts
// extension/tests/managed-mode.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

// Same harness shape as tests/switch-marker.test.ts. Telemetry is empty (pi.exec
// yields nothing) so the ladder's stable pick for a sonnet+free-kilo registry is:
// sonnet -> kilo free (forced switch), kilo -> kilo (no switch).
function harness(models: unknown[], currentModel: unknown) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: Array<{ provider?: string; id?: string }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const providerCalls: Array<{ name: string; sourceId: string }> = [];
  let current = currentModel;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider(name: string, _config: unknown, sourceId: string) {
      providerCalls.push({ name, sourceId });
    },
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel(m: unknown) {
      setModelCalls.push(m as { provider?: string; id?: string });
      current = m;
      return true;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m: any) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify(text: string, level = 'info') { notifications.push({ text, level }); } },
  };
  adaptiveRouter(pi);
  return { handlers, ctx, setModelCalls, notifications, providerCalls, setCurrent: (m: unknown) => { current = m; } };
}

const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', cost: { input: 2, output: 10 } };
const kiloFree = { provider: 'kilo', id: 'deepseek/deepseek-v4-flash-0731:free', cost: { input: 0, output: 0 } };
const virtualBalanced = { provider: 'router', id: 'balanced', cost: { input: 0, output: 0 } };

async function startSession(h: ReturnType<typeof harness>): Promise<void> {
  for (const h2 of h.handlers.get('session_start')!) await h2({}, h.ctx);
}

async function turn(h: ReturnType<typeof harness>): Promise<void> {
  for (const h2 of h.handlers.get('before_agent_start')!) await h2({}, h.ctx);
}

test('a session on a concrete model is manual: no registration-time routing, no switch, ever', async () => {
  const h = harness([sonnet, kiloFree], sonnet);
  await startSession(h);
  await turn(h);
  await turn(h); // second turn proves "never again", not just "not this turn"
  assert.deepEqual(h.setModelCalls, []);
});

test('cold start on router/balanced switches to the ladder winner before first work', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h);
  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0].id, kiloFree.id);
  const marker = h.notifications.find((n) => n.text.startsWith('[omp:router] '));
  assert.ok(marker, 'expected an [omp:router] marker for the bootstrap switch');
});

test('after a router switch the next turn stays managed (affinity through lastRouterSelected)', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h); // router/balanced -> kilo free, lastRouterSelected = kilo key
  assert.equal(h.setModelCalls.length, 1);
  await turn(h); // current == lastRouterSelected -> stay put
  assert.equal(h.setModelCalls.length, 1);
});

test('a manual /model change mid-session flips to manual and stops routing', async () => {
  const h = harness([sonnet, kiloFree, virtualBalanced], virtualBalanced);
  await startSession(h);
  await turn(h);
  assert.equal(h.setModelCalls.length, 1);
  h.setCurrent(sonnet); // user picked a concrete model the router did not select
  await turn(h);
  assert.equal(h.setModelCalls.length, 1, 'manual switch must not trigger a counter-switch');
  await turn(h);
  assert.equal(h.setModelCalls.length, 1, 'manual mode is sticky');
});

test('a failed router switch does not poison the state machine', async () => {
  // pi.setModel returns false: the switch failed. lastRouterSelected must stay unset
  // so the next turn re-enters managed mode and retries the switch instead of
  // misreading the virtual model as a manual override.
  let calls = 0;
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { calls += 1; return false; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const current = { provider: 'router', id: 'balanced', cost: {} };
  const models = [sonnet, kiloFree, current];
  const ctx: any = {
    models: {
      list: () => models,
      current: () => current,
      resolve: (selector: string) => models.find((m: any) => `${m.provider}/${m.id}` === selector),
    },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  adaptiveRouter(pi);
  for (const f of handlers.get('session_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  assert.equal(calls, 2, 'failed switch must be retried next turn (mode not latched, lastRouterSelected unset)');
});

test('manual mode skips telemetry work entirely (no exec calls in manual turns)', async () => {
  let execCalls = 0;
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { execCalls += 1; return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const current = { provider: 'anthropic', id: 'claude-sonnet-5', cost: {} };
  const ctx: any = {
    models: { list: () => [current], current: () => current, resolve: () => undefined },
    sessionManager: { getBranch: () => [{ type: 'session_init', modelRole: 'default' }], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { notify() {} },
  };
  adaptiveRouter(pi);
  for (const f of handlers.get('session_start')!) await f({}, ctx);
  for (const f of handlers.get('before_agent_start')!) await f({}, ctx);
  assert.equal(execCalls, 0, 'manual session must not poll telemetry');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/managed-mode.test.ts`
Expected: FAIL — currently the router routes regardless of current model (e.g. test 1 sees `setModelCalls.length === 1` because today's router switches sonnet→kilo free).

- [ ] **Step 3: Implement in `index.ts`**

1. Add imports at the top (after the existing `./runtime.ts` import block):

```ts
import { registerVirtualRouterProvider, resolveModeTransition, virtualModeForModelKey, type RoutingMode } from './virtual-model.ts';
```

2. In `adaptiveRouter(pi)`, immediately after `pi.setLabel('Adaptive Model Router');`:

```ts
registerVirtualRouterProvider(pi);
```

3. Add state next to the existing `let lastRoutedSelector` declarations (index.ts:86-95 area):

```ts
let routingMode: RoutingMode = 'manual';
let lastRouterSelected: string | undefined;
```

4. Replace the body of `pi.on('before_agent_start', …)` (index.ts:211-249) with:

```ts
pi.on('before_agent_start', async (_event: any, ctx: any) => {
    const currentKey = modelKey(ctx.models.current());
    const previousMode = routingMode;
    routingMode = resolveModeTransition(previousMode, currentKey, lastRouterSelected);
    if (previousMode !== 'manual' && routingMode === 'manual') {
      logger.info('adaptive-router opt-out: manual model selection', { currentKey });
    }
    if (routingMode === 'manual') return undefined;
    if (!shouldRouteBeforeAgentStart(retryActive)) return undefined;
    try {
      await refreshLive(false);
      // History and public intelligence are ranking hints; they never block new work.
      ctx.setTimeout(() => refreshHistory(false), 0);
      ctx.setTimeout(() => refreshIntel(ctx), 0);

      // Task 5 changes this call to chooseForCurrentWork(ctx, routingMode); until then
      // chooseForCurrentWork keeps its guessed tier — do NOT touch its signature here.
      const { selection } = chooseForCurrentWork(ctx);
      if (selection) {
        const target = ctx.models.resolve(selection.route.selector);
        const current = ctx.models.current();
        if (target && currentKey !== selection.route.key) {
          const changed = await pi.setModel(target);
          if (!changed) {
            logger.warn('adaptive-router could not switch model', { selector: selection.route.selector });
            // A failed switch must not claim the target: next turn must retry.
            lastRouterSelected = undefined;
          } else {
            announceSwitch(ctx, currentKey, selection.route.key, selection.reason);
            lastRouterSelected = selection.route.key;
          }
        }
        lastRoutedSelector = selection.route.key;
      }
      const pressure = pressureForSelection(selection);
      const content = pressureMessage(pressure);
      if (content) {
        return {
          message: {
            customType: 'adaptive-router.resource-pressure',
            content,
            display: false,
            details: { pressure },
          },
        };
      }
    } catch (error) {
      logger.warn('adaptive-router selection failed open', { error: String(error) });
      return undefined;
    }
    return undefined;
  });
```

This is the complete new handler body — the pressure block matches the current index.ts:232-243 verbatim; nothing else in the handler survives.

- [ ] **Step 4: Run the new tests and the full suite**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/managed-mode.test.ts && bun test`
Expected: managed-mode 6 pass; full suite green EXCEPT pre-existing router-behaviour tests that assumed auto-routing on concrete models (they are updated in Task 5, not here). If any of `index-affinity.test.ts`, `switch-marker.test.ts` fail at this point, their harnesses must seed `router/*` selection to enter managed mode — apply the minimal harness change now (set `current` to a `router/*` model object or add a `router/*` model to the list) and note it for Task 5 cleanup.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/index.ts extension/tests/managed-mode.test.ts extension/tests/index-affinity.test.ts extension/tests/switch-marker.test.ts
git commit -m "feat: managed routing only for router/* opt-in; manual model selection opts out"
```

### Task 4: Fail-closed transport guard for the virtual provider

**Files:**
- Modify: `extension/index.ts`
- Test: `extension/tests/virtual-leak-guard.test.ts`

**Interfaces:**
- Consumes: `VIRTUAL_PROVIDER`, `virtualModeForModelKey` from `./virtual-model.ts`; `ctx.abort()` (verified present on every extension ctx shape in OMP 18.2.6 — spec §4).
- Produces: `pi.on('before_provider_request', …)` handler. The event payload (`event.payload`) carries the outgoing request; the tracer (`tools/context-tracer/index.ts:78-108`) reads `payload.body.model ?? payload.model`. The handler: if the payload targets `provider === 'router'`, call `ctx.abort()` (if callable), notify with the fail-closed message, and return `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// extension/tests/virtual-leak-guard.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import adaptiveRouter from '../index.ts';

test('a provider request targeting router/* aborts the turn with a loud local error', async () => {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const notifications: string[] = [];
  let aborted = false;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: { list: () => [], current: () => undefined, resolve: () => undefined },
    sessionManager: { getBranch: () => [], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    ui: { notify(text: string) { notifications.push(text); } },
    abort() { aborted = true; },
  };
  adaptiveRouter(pi);
  const handler = handlers.get('before_provider_request')?.[0];
  assert.ok(handler, 'guard handler must be registered');
  const payload = { body: { model: 'balanced', messages: [] } };
  const result = await handler({ type: 'before_provider_request', payload }, ctx);
  assert.equal(result, undefined, 'guard must not rewrite the payload');
  assert.equal(aborted, true, 'ctx.abort() must fire');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /adaptive-router: virtual router model leaked/);
});

test('requests to real providers pass through untouched', async () => {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  let aborted = false;
  const pi: any = {
    setLabel() {},
    on(name: string, handler: (e: unknown, c: unknown) => Promise<unknown>) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {},
    registerProvider() {},
    async exec() { return { code: 1, stdout: '', stderr: '' }; },
    async setModel() { return true; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  const ctx: any = {
    models: { list: () => [], current: () => undefined, resolve: () => undefined },
    sessionManager: { getBranch: () => [], getSessionId: () => 's1' },
    setTimeout() {},
    setInterval() {},
    ui: { notify() {} },
    abort() { aborted = true; },
  };
  adaptiveRouter(pi);
  const handler = handlers.get('before_provider_request')?.[0];
  const payload = { body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] } };
  const result = await handler({ type: 'before_provider_request', payload }, ctx);
  assert.equal(result, undefined);
  assert.equal(aborted, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/virtual-leak-guard.test.ts`
Expected: FAIL — `assert.ok(handler, 'guard handler must be registered')` (no such hook yet).

- [ ] **Step 3: Implement the guard in `index.ts`**

Add after the `before_agent_start` handler registration (after index.ts:249 in the post-Task-3 file):

```ts
  // Fail-closed seatbelt (spec §4): the virtual provider's baseUrl is the discard
  // port. If a request is about to reach it, the router failed its one job — abort
  // the turn immediately instead of burning OMP's 10 silent auto-retries.
  pi.on('before_provider_request', async (event: any, ctx: any) => {
    const body = event?.payload?.body ?? event?.payload;
    const leaked = body?.model !== undefined && virtualModeForModelKey(`${VIRTUAL_PROVIDER}/${body.model}`) !== undefined;
    if (!leaked) return undefined;
    try {
      ctx.abort?.();
    } catch (error) {
      logger.warn('adaptive-router guard abort failed', { error: String(error) });
    }
    try {
      ctx.ui?.notify?.(
        'adaptive-router: virtual router model leaked to provider transport — this is a router bug; select a concrete model with /model',
        'error',
      );
    } catch { /* a notify failure must not mask the abort */ }
    return undefined;
  });
```

(`VIRTUAL_PROVIDER` comes from the Task 3 import — extend that import statement.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/virtual-leak-guard.test.ts && bun test`
Expected: guard 2 pass; full suite green (modulo tests already fixed in Task 3).

- [ ] **Step 5: Mutation check — the guard is red-capable**

Temporarily delete the `leaked` check body (make the handler return `undefined` unconditionally), run:

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/virtual-leak-guard.test.ts`
Expected: FAIL (abort not called). Restore the guard. Run full suite again, expected green.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/index.ts extension/tests/virtual-leak-guard.test.ts
git commit -m "feat: fail-closed guard aborts any request that reaches the virtual router provider"
```

### Task 5: Remove the guessed-tier activation path

**Files:**
- Modify: `extension/policy.ts`, `extension/types.ts`, `extension/index.ts`, `extension/runtime.ts`
- Test: `extension/tests/policy.test.ts`, `extension/tests/runtime.test.ts`, `extension/tests/managed-mode.test.ts`

**Interfaces:**
- Consumes: `RoutingMode`/`virtualModeForModelKey` from `./virtual-model.ts`.
- Produces:
  - `policy.ts`: `DEFAULT_POLICY` without `agentTiers`; `normalizePolicy(raw)` returns `{ tiers }` only; **delete** `tierForRole`, `tierForSession` and the `agentTiers` field handling.
  - `types.ts`: `RouterPolicy` loses `agentTiers?`; `SessionIdentity` loses `modelRole` (keep `agent?` — used by `latestSessionIdentity` for diagnostics).
  - `index.ts`: `chooseForCurrentWork(ctx)` signature becomes `chooseForCurrentWork(ctx, mode: ManagedMode)`; `tierForSession` import removed; `lastDecision.tier` stores the mode.
  - `runtime.ts`: `latestSessionIdentity` unchanged except it stops reading `modelRole`; `allowDrainingForTier` unchanged (modes are tiers).
- `extension/tests/policy.test.ts`: delete the `tierForRole` test (lines 5-12) and `tierForSession` assertions (lines 34-38); keep classification/decoration tests; update `normalizePolicy` test to assert `agentTiers` is gone.
- `extension/tests/runtime.test.ts`: update `latestSessionIdentity` test (lines 13-20) to the exact code shown in Step 1 below (assert `deepEqual({ agent: 'reviewer' }, …)` since `modelRole` no longer exists).

- [ ] **Step 1: Update policy/runtime tests first (RED)**

In `extension/tests/policy.test.ts`:
- Remove the import of `tierForRole` and `tierForSession`.
- Delete the test `tierForRole maps OMP roles to workload tiers`.
- Delete the test `session agent override beats model role and unknown sessions default balanced`.
- Replace the `normalizePolicy` test with:

```ts
test('normalizePolicy accepts tier class overrides and drops the removed agentTiers surface', () => {
  const p = normalizePolicy({ agentTiers: { builder: 'frontier' }, tiers: { small: { classes: ['x'] } } });
  assert.equal((p as Record<string, unknown>).agentTiers, undefined);
  assert.deepEqual(p.tiers.small.classes, ['x']);
});
```

In `extension/tests/runtime.test.ts`, replace the `latestSessionIdentity` test with:

```ts
test('latestSessionIdentity reads the most recent session_init agent (modelRole is gone)', () => {
  const branch: any[] = [
    { type: 'session_init', agent: 'scout', modelRole: 'smol' },
    { type: 'message', message: { role: 'user' } },
    { type: 'session_init', agent: 'reviewer', modelRole: 'plan' },
  ];
  assert.deepEqual(latestSessionIdentity(branch), { agent: 'reviewer' });
});
```

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/policy.test.ts tests/runtime.test.ts`
Expected: FAIL — `tierForRole` import error gone but `normalizePolicy` still returns `agentTiers`; `latestSessionIdentity` still returns `modelRole`.

- [ ] **Step 2: Implement the deletions**

`policy.ts`:
- Delete `tierForRole` (lines 23-27) and `tierForSession` (lines 29-35).
- `DEFAULT_POLICY`: remove the `agentTiers` block (lines 10-15).
- `normalizePolicy`: remove the `agentTiers` collection (lines 116-119), return `{ tiers }` only.
- Remove now-unused `Tier` import if flagged.

`types.ts`:
- `RouterPolicy`: delete `agentTiers?: Record<string, Tier>` (line 44).
- `SessionIdentity`: delete `modelRole?: string` (line 49).

`runtime.ts`:
- In `latestSessionIdentity` (lines 8-14): delete the `modelRole` line; keep `agent`.

`index.ts`:
- Change `chooseForCurrentWork` (lines 164-180) to accept the mode:

```ts
  const chooseForCurrentWork = (ctx: any, mode: ManagedMode) => {
    const routes = currentRoutes(ctx);
    const selection = selectForTier(
      routes,
      policy.tiers[mode].classes,
      {
        allowDraining: allowDrainingForTier(mode),
        preference: mode === 'small' ? 'speed' : 'quality',
        currentKey: modelKey(ctx.models.current()),
      },
    );
    lastDecision = { tier: mode, selection, routes, at: Date.now() };
    return { routes, selection };
  };
```

- Remove the `tierForSession` import (index.ts:5) and the `latestSessionIdentity` call; in `before_agent_start` pass the mode down: change the call to `const { selection } = chooseForCurrentWork(ctx, routingMode === 'manual' ? 'balanced' : routingMode);` and add a one-line comment `// unreachable: manual returned above — 'balanced' keeps the type happy without a cast`. (TypeScript cannot narrow `routingMode` across the `try` block boundary; the explicit fallback documents the invariant without `as`.)
- Add `import type { ManagedMode } from './virtual-model.ts';` (extend the Task 3 import).

- [ ] **Step 3: Run the full suite (GREEN)**

Run: `cd ~/Projects/poor-mans-router/extension && bun test`
Expected: all pass. Arithmetic: 69 prior + 6 virtual-model + 6 managed-mode + 2 guard = 83 registered tests, minus the 2 removed policy tests and 1 rewritten runtime test = 80 active; the suite must report 80 pass, 0 fail (bun counts a rewritten test once).

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/policy.ts extension/types.ts extension/index.ts extension/runtime.ts extension/tests/policy.test.ts extension/tests/runtime.test.ts
git commit -m "refactor: delete agent/modelRole tier guessing; mode now comes only from router/* selection"
```

### Task 6: `route-status` shows routing mode

**Files:**
- Modify: `extension/index.ts`, `extension/status.ts`
- Test: `extension/tests/status.test.ts`

**Interfaces:**
- Consumes: `formatRouteStatus` (status.ts:25), `routingMode` closure state.
- Produces: `RouteStatusInput` gains optional `mode?: string`; when present, `formatRouteStatus` renders a first line `mode: <value>`. The command shows `mode: manual (opt-out — select router/* to re-enable)` when in manual mode, without requiring `lastDecision`.

- [ ] **Step 1: Write the failing test additions in `extension/tests/status.test.ts`**

Append (keeping existing tests untouched — read the file first and match its import style):

```ts
test('mode line renders first when provided', () => {
  const text = formatRouteStatus({
    tier: 'balanced',
    mode: 'manual (opt-out — select router/* to re-enable)',
    routes: [],
    sources: {},
  });
  const lines = text.split('\n');
  assert.match(lines[0], /^mode: manual \(opt-out/);
  assert.match(lines[1], /^tier: balanced$/);
});
```

(If the file does not import `formatRouteStatus` yet, add `import { formatRouteStatus } from '../status.ts';` following the existing convention.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/status.test.ts`
Expected: FAIL — no `mode` line rendered.

- [ ] **Step 3: Implement**

`status.ts`: add `mode?: string;` to `RouteStatusInput`; in `formatRouteStatus`, replace the current `lines` initializer (status.ts:26-32) so the array starts with the optional mode line followed by all existing entries — keep every existing entry (`tier`, `selected`, `reason`, blank, `'health:'`) exactly as-is below the spread:

```ts
  const lines = [
    ...(input.mode !== undefined ? [`mode: ${input.mode}`] : []),
    `tier: ${input.tier}`,
    `selected: ${input.selected ?? '(none)'}`,
    `reason: ${input.reason ?? '(none)'}`,
    '',
    'health:',
  ];
```

`index.ts` `route-status` handler: before the `if (!lastDecision)` guard (index.ts:321), handle manual mode:

```ts
      const key = modelKey(ctx.models.current());
      if (virtualModeForModelKey(key) === undefined) {
        ctx.ui.notify('adaptive-router: mode manual (opt-out — select router/* to re-enable)', 'info');
        return;
      }
```

and add `mode: routingMode` to the `formatRouteStatus` call.

- [ ] **Step 4: Run tests**

Run: `cd ~/Projects/poor-mans-router/extension && bun test tests/status.test.ts && bun test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/index.ts extension/status.ts extension/tests/status.test.ts
git commit -m "feat: route-status reports routing mode and manual opt-out"
```

### Task 7: Policy cleanup + README/AGENTS/docs update

**Files:**
- Modify: `extension/policy.yml`, `README.md`, `AGENTS.md`, `docs/design.md` (activation section only), `config/config-patch.yml` (unchanged — verify no agentTiers references)
- Test: none (docs)

**Interfaces:** none new.

- [ ] **Step 1: Audit and update `extension/policy.yml`**

Run: `grep -n 'agentTiers\|modelRole\|tierForSession' ~/Projects/poor-mans-router/extension/policy.yml ~/Projects/poor-mans-router/extension/*.ts ~/Projects/poor-mans-router/extension/tests/*.ts ~/Projects/poor-mans-router/config/*.yml`
Expected: no hits in `policy.yml`/`config/`. If `policy.yml` contains an `agentTiers:` block, delete it (it has no effect after Task 5).

- [ ] **Step 2: Update docs**

`README.md`: replace the activation description with the opt-in contract — three virtual selectors, manual = opt-out, Multica mapping table (spec §7), the fail-closed guard behaviour.
`AGENTS.md`: update I11 to mention `pi.registerProvider`; add the new invariants N1–N4 from spec §8 with their guarding test files; update the "How to change routing behaviour" step 3 to point at `docs/spec-virtual-model-routing.md` for the activation contract.
`docs/design.md`: mark the activation-by-guessed-tier section as superseded, one pointer line to the spec (do not rewrite the design doc — it is a historical record; a dated supersession note is enough).

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/poor-mans-router
git add extension/policy.yml README.md AGENTS.md docs/design.md
git commit -m "docs: virtual-model opt-in contract; policy.yml drops agentTiers"
```

### Task 8: Live verification against real OMP

**Files:**
- Create (temporary, not committed): `/tmp/vr-live/virtual-router.ts` — a copy of the extension exercising the real paths, OR install the extension (Step 4) and test in place.
- Test: manual smoke, results recorded in the commit message of Task 9.

**Interfaces:** none new.

- [ ] **Step 1: Full suite + differential replay**

Run: `cd ~/Projects/poor-mans-router/extension && bun test`
Expected: 0 fail.

Differential replay per AGENTS.md step 5: with the fixture snapshot (`fixtures/omp-usage.json`, `fixtures/codexbar-usage.json`, `fixtures/models.json`), confirm the only selection changes vs `main` are (a) sessions on concrete models no longer route, (b) `router/*` sessions route by mode instead of guessed role. Record any other flip and stop if unexplained.

- [ ] **Step 2: Install**

```bash
cd ~/Projects/poor-mans-router
scripts/install.sh
```

Expected: installed to `$(omp config path)/extensions/adaptive-router/`, backup printed. Re-verify installed hashes match the repo (`diff -r extension/*.ts "$(omp config path)/extensions/adaptive-router/"`).

- [ ] **Step 3: Cold-start managed session**

```bash
cd /tmp && omp --no-session --mode json -p "Reply with exactly: MANAGED_OK" --model router/balanced 2>&1 | grep -o '"provider":"[^"]*","model":"[^"]*"\|MANAGED_OK' | sort | uniq -c
```

Expected: first (or only) assistant message has a concrete provider (anthropic/kilo/etc.), `MANAGED_OK` present, no `provider":"router"` request in the stream.

- [ ] **Step 4: Manual opt-out session**

```bash
cd /tmp && omp --no-session --mode json -p "Reply with exactly: MANUAL_OK" --model "kilo/deepseek/deepseek-v4-flash-0731:free" 2>&1 | grep -o '"provider":"[^"]*","model":"[^"]*"\|MANUAL_OK' | sort | uniq -c
```

Expected: single concrete model, no switches.

- [ ] **Step 5: Guard smoke (fail-closed)**

Temporarily break the router's switch path (e.g. edit the installed `index.ts` to make `before_agent_start` return early without switching, leaving current = `router/balanced`), run Step 3 again.

Expected: the turn does NOT hang in retries; an `[omp:…]`-style error/notice about the leaked virtual model appears; restore the installed file from the repo and re-run Step 3 to confirm green. If `ctx.abort()` turns out to leave the TUI in a broken state (empirical check), fall back to the documented alternative: log loudly + notify on every retry (message includes the guard text), and note the deviation in the Task 9 report.

- [ ] **Step 6: `/route-status` live proof**

One fresh interactive `omp` session on `router/balanced`: after the first turn run `/route-status`, expect `mode: balanced`, a concrete `selected:` route, and populated health rows.

### Task 9: Final verification, changelog, handoff

**Files:**
- Modify: `docs/ROADMAP.md` (mark roadmap #3 done)

**Interfaces:** none.

- [ ] **Step 1: Full suite one more time**

Run: `cd ~/Projects/poor-mans-router/extension && bun test`
Expected: 0 fail.

- [ ] **Step 2: Update `docs/ROADMAP.md`**

- Item 3 (visible model-switch marker): mark done, reference the `switchMarker` commit.
- Add a line under completed work: virtual-model opt-in contract shipped, spec link.

- [ ] **Step 3: Commit and report**

```bash
cd ~/Projects/poor-mans-router
git add docs/ROADMAP.md
git commit -m "docs: roadmap update — virtual-model routing shipped"
```

Report contents: suite counts before/after, the two live smoke outputs, guard smoke result, `/route-status` capture, and any Task 8 step-5 deviation.
