# Spec — Virtual-model routing semantics (`pmr/*`)

Status: **DRAFT for review**. Not approved for implementation.
Predecessor: `docs/design.md` §activation; supersedes the agent/modelRole-derived tier activation described there.
Input: design directive from the human partner (this session, 2026-09-19) + verified against OMP 18.2.6 binaries (`/opt/homebrew/Cellar/omp/18.2.6`).

---

## 0. Contract change in one sentence

The router **stops guessing which sessions it owns**. It owns a session if and only if the session's current model is one of three virtual selectors it registered itself; any manual selection of a concrete model is an explicit opt-out.

## 1. Verified platform facts (OMP 18.2.6, probed empirically 2026-09-19)

These were verified by reading the shipped binary and by live cold-start experiments (`/tmp/router-virtual-test`, fixtures inline in §10):

| # | Fact | Evidence |
|---|---|---|
| F1 | `pi.registerProvider(name, config, sourceId)` exists on the extension API and registers provider + static `models[]` into the live model registry; registration is deferred until the first registry refresh and then projected into `ctx.models.list()` / `/model` picker / `--model` resolution. | binary: `registerProvider(e,t,s)` → `pendingProviderRegistrations` → `t.registerProvider(...)` → `refreshRuntimeProviders()`; live test: `--model pmr/balanced` resolves and the TUI status shows `provider=pmr model=balanced`. |
| F2 | A runtime-registered provider that ships **static models** must pass `validateProviderConfiguration` (`sit`): `baseUrl` required, and `apiKey` (or `oauth`) required — `auth:"none"` does **not** exempt `runtime-register`. | `sit()` in binary; cold-start runs: first attempt threw `Provider router: "baseUrl" is required…`, second threw `Provider router: "apiKey" or "oauth" is required…` |
| F3 | A request that actually reaches a `pmr/*` model fails with OMP's connection error (`Unable to connect…`) and burns OMP's retry budget (we observed `auto_retry_start` with `maxAttempts:10`). | live cold-start test without mid-switch: 3 failed turns, then abort |
| F4 | `pi.setModel(modelObject)` performs the switch. Passing a **selector string** is broken in 18.2.6's extension wrapper (`runExtensionSetModel` calls `modelRegistry.getApiKey(t)` on the raw argument; a string has no `.provider` → returns `false` silently). The existing extension already does the right thing: `ctx.models.resolve(selector)` first. | binary `IUe(e,t)`; live: string → `false`, resolved object → `true` |
| F5 | `setModel` to a virtual `pmr/*` model **succeeds** when the registered provider carries a (dummy) `apiKey` — `hasConfiguredAuth` sees the runtime key. | live: switch back to `pmr/balanced` returned `true` in-process |
| F6 | `ctx.models.current()` reflects both `--model` and `pi.setModel`. | live tests |
| F7 | Cold start works: `omp --model pmr/balanced -p …` resolves the extension-registered model. The "cold start can't resolve dynamic extension models" concern was **not** observed for static `models[]` registered at extension load (registration happens before first model resolution in `-p` mode). | live cold-start matrix in §10 |

Consequence of F2+F3: the registration **must** include a syntactically valid `baseUrl` + `apiKey` that must **never be contacted**. This is a fail-open trap unless the router guarantees a switch away before any request. Mitigations in §4.

## 2. Virtual models

Exactly three, statically registered at extension load:

```text
pmr/frontier
pmr/balanced
pmr/small
pmr/free
```

Provider registration (shape that passes F2):

```ts
pi.registerProvider('router', {
  name: 'Router (adaptive)',
  baseUrl: 'http://127.0.0.1:9',      // discard port; MUST never be contacted (see §4 guard)
  apiKey: 'not-a-key',                 // placeholder; satisfies validateProviderConfiguration
  models: [
    { id: 'frontier', name: 'Router: Frontier', api: 'openai-completions', supportsTools: true },
    { id: 'balanced', name: 'Router: Balanced', api: 'openai-completions', supportsTools: true },
    { id: 'small',    name: 'Router: Small',    api: 'openai-completions', supportsTools: true },
  ],
}, 'adaptive-router');
```

Naming is final (`pmr/*`), per partner decision: four tiers, `small` keeps its paid rungs and `free` is free-only by contract.

## 3. Routing-mode state machine

Per-session, in-memory (extension lifetime), **not persisted**:

```text
type RoutingMode = 'manual' | 'frontier' | 'balanced' | 'small'
```

Transitions, evaluated on every `before_agent_start` (and on `session_start` for cold start), based **only** on `ctx.models.current()`:

| current model | prior state | new state | action |
|---|---|---|---|
| `pmr/frontier` | any | `frontier` | none yet (see below) |
| `pmr/balanced` | any | `balanced` | none |
| `pmr/small` | any | `small` | none |
| `key == lastRouterSelected` | frontier/balanced/small | unchanged | **stay managed** (this was our own switch) |
| anything else | frontier/balanced/small | `manual` | **do nothing, ever after** |
| anything | `manual` | `manual` | no action |
| anything | `manual` | `manual` | (only a `pmr/*` selection re-enters managed mode) |

Managed-mode routing action (per turn, unchanged from current ladder):

1. refresh telemetry (existing `refreshLive/History/Intel`);
2. `selectForTier(routes, policy.tiers[mode].classes, …)`;
3. if `selection.route.key !== currentKey`: `pi.setModel(ctx.models.resolve(selection.route.selector))`; on success set `lastRouterSelected = selection.route.key` and announce the switch (existing `announceSwitch` from BUG C work);
4. pressure message injection unchanged.

On `session_start`, if `ctx.models.current()` is a `pmr/*` model, mode is set accordingly and `lastRouterSelected = undefined`; the router switches to the concrete winner at the first `before_agent_start` (same as today's bootstrap, but triggered by explicit opt-in rather than guessed tier).

**Cold start (`--model pmr/balanced`)**: verified working in `-p` mode (F7). The first request still goes out with `current=pmr/balanced` unless the router switches **before** the first provider request. `before_agent_start` runs before the first request in a turn — same mechanism the current router already uses for its bootstrap switch (BUG C case 3b proved the switch lands before the request). The §4 guard covers the residual risk.

## 4. Fail-closed guard for the fake provider

If, for any reason, a request is about to be sent **to** `provider === 'router'` (switch failed, event ordering, host quirk), that request would hit `http://127.0.0.1:9` and fail with retries (F3). Guard:

- hook `before_provider_request`;
- if `event/model.provider === 'router'` (any `pmr/*` model): **abort the turn locally** with a clear, non-retryable error:
  `pmr: virtual model leaked to provider transport — this is a router bug; select a concrete model with /model`.
- No attempt to "fix" the request in-flight; fail closed, loud.

This converts the worst case from "burn 10 silent retries" (F3) into one immediate actionable error.

## 5. What is deleted from the current activation path

Everything that lets the router act **without** a `pmr/*` selection:

- `tierForSession` / `tierForRole` role-based tier inference (policy.ts:23–35) — delete from activation path;
- `policy.agentTiers` — delete (may remain as purely diagnostic metadata in `/route-status` if wanted, but has **no** routing authority);
- current-model→tier guessing (`classifyModelId` used for activation) — keep `classifyModelId` only for route decoration, it already is;
- default auto-routing on plain sessions — removed; a session started with a concrete model is `manual` forever;
- bootstrapModels (if any remain in runtime wiring).

`before_agent_start` becomes: resolve mode → if `manual`, return `undefined` immediately (no telemetry refresh is even needed; skip all refresh work in manual mode).

## 6. Native fallback stays intact

`manual` means "adaptive-router doesn't switch models". It does **not** disable OMP's own retry/`modelFallback` for the active turn — that's OMP core behavior (`retry.fallbackChains`), untouched by this change. Cooldowns recorded by `auto_retry_start` handling remain per-route state used only when the router is active.

## 7. Multica mapping

- Frontier agent → `model: pmr/frontier`
- Balanced agent → `model: pmr/balanced`
- Small agent → `model: pmr/small`
- Pinned agent → `model: anthropic/claude-sonnet-5` (etc.) — no bootstrap mappings.

Cold-start requirement from Multica (`omp -p --mode json --session <file> --model X`): verified in §10 test 2.

## 8. Invariants impact

| Invariant | Impact |
|---|---|
| I1–I10 | unchanged (ladder/comparator semantics untouched) |
| I11 | still true — router only calls `pi.setModel`; it now also *registers* a provider (registration creates no session/branch) |
| I12 | unchanged — the placeholder `apiKey` is a constant, not a secret; document that it is never a real credential |

New invariants to add tests for:

- **N1**: No turn is ever routed while mode is `manual` (mutation test: delete the mode check → red).
- **N2**: `pmr/*` never reaches a provider request (§4 guard → red by removing the guard).
- **N3**: A router `setModel` sets `lastRouterSelected` and the next turn with `current == lastRouterSelected` stays in managed mode.
- **N4**: A manual change to any non-`pmr/*`, non-`lastRouterSelected` model flips mode to `manual` and the router never switches again for the session lifetime.

## 9. Known edge cases

1. **Manual selection of the exact model the router just chose** (`current == lastRouterSelected`) is indistinguishable from our own switch — by design; it stays managed. If the user wants manual control of that concrete model they must either pick a different concrete model first or pick `pmr/*` again. Documented UX cost of origin-free detection (accepted by the directive: "без ненадёжной попытки угадать происхождение каждого model-change event").
2. **Session resume**: mode is rebuilt from `current()` at first `before_agent_start` — a session resumed onto `pmr/balanced` is managed again; resumed onto a concrete model is manual. No persistence, no stale state.
3. **`/model` to another `pmr/*` tier mid-session**: allowed; mode re-targets, `lastRouterSelected` resets.
4. **BUG C legacy sessions** (remote-compacted on openai-codex): unaffected by this change; the compaction guard from the compaction decision (`remote` removed from `compaction.methodOrder`) prevents *new* non-portable compactions; legacy sessions pinned per earlier plan.
5. **Subagents/roles**: role-based models (`modelRoles`) select concrete models — those sessions are `manual` unless the user explicitly picks `pmr/*`. Multica agents get `pmr/*` via their model field (§7).
6. **Two extensions registering `router`**: name collision — second registration replaces (per-source `registerProvider` map); not a scenario we support, `adaptive-router` is single-writer installed.

## 10. Verification performed (live, OMP 18.2.6, 2026-09-19)

| # | Test | Result |
|---|---|---|
| 1 | Extension registers `router/{frontier,balanced,small}`; `--model pmr/balanced` cold start; request reaches provider `router` | resolved ✓; request **fails with connect error to 127.0.0.1:9** after retries (proves F3, guard needed) |
| 2 | Same cold start + mid-turn `setModel(resolved openrouter model)` before first request | first request goes out as `openrouter/~deepseek/deepseek-v4-flash-latest`, native fallback chain works (`nvidia/nemotron-3-ultra…:free` answered `REAL_OK`), `switched: true` (proves F1/F4/F6, and that the switch-before-request pattern works) |
| 3 | Manual `--model openrouter/~deepseek/…` with the virtual extension loaded | normal session, no router interference (`MANUAL_OK`) |

## 11. Out of scope (unchanged)

- Compaction behavior (fixed separately: `remote` already removed from `compaction.methodOrder` in user config today; see BUG C report).
- Class ladder / policy.yml semantics.
- Deploy lock (roadmap item 2).

## 12. Open questions for the reviewer

1. **`api` for the fake models**: we register `openai-completions` (any valid api string passes validation). Alternative: omit `api` on models and set it on the provider — same result. No functional difference since the endpoint is never contacted. **Default: keep as in §2.**
2. **`route-status` in manual mode**: show "manual (opt-out)" plus last decision, or nothing? **Default proposed: show mode + reason, no route list.**
3. Should `pmr/*` appear in `/model` picker grouped/labeled (F1 says yes, they appear automatically)? No action needed — cosmetic only.
