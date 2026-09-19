# OMP Adaptive Model Routing — Design Spec

**Date:** 2026-09-18  
**Status:** Proposed design, ready for review  
**Target:** oh-my-pi / `omp` with a small in-process extension; no external LLM proxy in the request path

## 1. Goal

Build a resilient, low-maintenance routing layer for multiple OMP agents that:

- keeps native OMP retry, credential rotation, usage-aware fallback, role routing, and cooldown behavior;
- chooses among subscription, PAYG, and free routes without hard-coding provider inventory;
- prefers **cheapest healthy route → cheapest available route → best available route**;
- respects three workload tiers: **frontier**, **balanced**, and **small**;
- uses OMP usage as the primary quota authority, CodexBar as secondary telemetry, runtime provider errors as hard temporary vetoes, OMP history for reliability/latency, and OpenRouter Data API for quality/task-fit signals;
- degrades gracefully instead of hitting a hard stop when quota/rate-limit runway is nearly exhausted;
- survives provider/model additions and removals without requiring code changes.

## 2. Chosen architecture

No LiteLLM-style proxy is added to the request path.

```text
Agents / OMP roles
       │
       ▼
┌───────────────────────────────┐
│ OMP native runtime            │
│ - modelRoles                  │
│ - fallbackChains              │
│ - credential rotation         │
│ - usage-aware preflight       │
│ - reactive retry/cooldown     │
└──────────────┬────────────────┘
               │
               │ model selection before new work
               ▼
┌───────────────────────────────┐
│ adaptive-router extension     │
│ - current OMP model registry  │
│ - OMP usage                   │
│ - CodexBar usage/pace/balance │
│ - cooldown cache              │
│ - OMP historical stats        │
│ - OpenRouter Data API cache   │
│ - tier/class policy           │
└───────────────────────────────┘
```

The extension **does not proxy model traffic**. It selects a concrete OMP model for subsequent requests and lets OMP execute the request normally.

OMP exposes extension lifecycle hooks, authenticated model listing/resolution, `setModel`, managed timers, provider usage hooks, and retry events. This is sufficient for an in-process policy layer without adding another network hop.

References:
- https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- https://github.com/can1357/oh-my-pi/blob/main/docs/non-compaction-retry-policy.md

## 3. Design principles

### 3.1 OMP owns mechanics; extension owns policy

Keep in OMP whenever possible:

- request execution;
- auth and credential rotation;
- provider-specific retry classification;
- `Retry-After` parsing;
- reactive fallback;
- native cooldown/revert behavior;
- usage-aware reserve protection;
- model/role resolution.

The extension adds only what native OMP does not express well enough:

- cross-provider price/health choice;
- multi-source availability synthesis;
- dynamic ordering inside user-defined model classes;
- free-route probing/recovery;
- simple graceful-drain signaling.

### 3.2 Provider inventory is discovered, never hard-coded

The extension starts from `ctx.models.list()` / OMP's model registry for the current session. Providers and models not present there are ignored. Newly added authenticated routes automatically become candidates if they match a class rule.

No provider list such as `Kilo | OpenRouter | OpenCode` is compiled into the code.

### 3.3 User tier boundaries dominate public benchmarks

OpenRouter benchmark/ranking data may reorder models **inside an allowed class**, but may not promote a model across the user's tier/class boundary.

Examples:

- Data API may reorder `DeepSeek V4 Pro` vs `GLM 5.3` inside `strong-chinese`.
- Data API may not promote a `balanced` model into the `fable` / `astra` / `opus` frontier slots.

## 4. Current OMP baseline from diagnostics

The diagnostic bundle shows these relevant settings today:

```yaml
modelRoles:
  default: anthropic/claude-sonnet-5
  smol: opencode-go/deepseek-v4.1-flash:auto
  plan: anthropic/claude-opus-5:auto
  advisor: openai-codex/gpt-6-astra:auto
  tiny: openrouter/~deepseek/deepseek-v4-flash-latest:auto

retry:
  enabled: true
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  maxRetries: 3
  maxDelayMs: 60000
  usageAwareFallback: false
  usageReservePct: 10
  usageReservePolicy: confirm
```

The first native change is therefore to enable proactive usage protection and make it non-interactive for agent workloads.

## 5. Native OMP configuration

Recommended baseline patch:

```yaml
retry:
  enabled: true
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry

  # Keep current conservative retry budget.
  maxRetries: 3
  maxDelayMs: 60000

  # Proactive quota protection.
  usageAwareFallback: true
  usageReservePct: 10
  usageReservePolicy: auto

  # Do not sit waiting for a long quota reset when another route exists.
  waitForUsageReset: false

task:
  # Important while tuning routing: show what actually handled the task.
  showResolvedModelBadge: true
```

### 5.1 Role intent

Roles map to workload tiers rather than vendor identities:

```text
frontier:  plan, slow, advisor, explicitly frontier custom agents
balanced:  default, task, normal coding/research agents
small:     smol, tiny, sonic/scout/high-volume lightweight agents
```

The concrete value stored in `modelRoles` remains a safe static primary, while the extension is allowed to select a better current route before new work begins.

### 5.2 Fallback chains

Broad provider wildcards should not be the main policy because exact model/provider wildcard chains take precedence over role chains and can accidentally cross tier boundaries.

Prefer role-oriented fallback chains as the last-resort reactive safety net. The extension remains responsible for choosing the best route before a request; OMP fallback chains exist so an unexpected mid-turn 429/outage can still recover.

A first-pass static shape is:

```yaml
retry:
  fallbackChains:
    plan:
      - anthropic/claude-fable-5-1
      - openai-codex/gpt-6-astra
      - anthropic/claude-opus-5
      - openai-codex/gpt-5.6-sol
      - opencode-go/deepseek-v4-pro
      - kilo/kilo-auto/frontier
      - openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

    advisor:
      - openai-codex/gpt-6-astra
      - anthropic/claude-fable-5-1
      - anthropic/claude-opus-5
      - openai-codex/gpt-5.6-sol
      - opencode-go/deepseek-v4-pro
      - kilo/kilo-auto/frontier
      - openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

    default:
      - anthropic/claude-sonnet-5
      - openai-codex/gpt-5.6-luna
      - opencode-go/deepseek-v4.1-flash
      - openrouter/z-ai/glm-5.3-flash
      - kilo/kilo-auto/balanced
      - openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

    task:
      - anthropic/claude-sonnet-5
      - openai-codex/gpt-5.6-luna
      - opencode-go/deepseek-v4.1-flash
      - openrouter/z-ai/glm-5.3-flash
      - kilo/kilo-auto/balanced
      - openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

    smol:
      - anthropic/claude-haiku-4-5
      - openai-codex/gpt-5.6-luna
      - openrouter/z-ai/glm-5.3-flash
      - kilo/kilo-auto/small
      - openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
      - openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

    tiny:
      - anthropic/claude-haiku-4-5
      - openai-codex/gpt-5.6-luna
      - kilo/kilo-auto/small
      - openrouter/z-ai/glm-5.3-flash
      - openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```

These are emergency chains, not the dynamic ranking algorithm. Missing/unavailable entries are expected to be skipped/fail over by OMP; the extension should normally avoid choosing known-dead routes in the first place.

## 6. Availability and source precedence

### 6.1 Planning authority

For proactive routing:

```text
1. OMP native usage report
2. CodexBar usage / pace / balance
3. extension's recent observed health/history
4. unknown = fail open, not fail closed
```

The rule `OMP > CodexBar` applies when both describe the same quota meter and disagree.

CodexBar remains valuable for:

- account-specific reset times;
- pace / `willLastToReset` projections;
- Kilo/OpenRouter balances;
- provider status;
- telemetry that OMP does not expose natively.

A CodexBar `No available fetch strategy`, missing login, or missing integration is **telemetry unavailable**, not evidence that the underlying OMP provider is unhealthy.

### 6.2 Runtime hard veto

A fresh provider response beats predictions for immediate availability:

```text
429 / quota_exhausted / usage_limit / Retry-After
        ↓
mark concrete route/credential COOLDOWN until hinted reset
        ↓
remove it from extension candidate selection
```

This does not mean API errors are globally more authoritative than OMP usage; it means a specific recent hard failure is an immediate temporary veto for that route.

Network errors and isolated 5xx/timeouts are not quota exhaustion. They may reduce health confidence but should not create a long quota cooldown unless OMP/provider supplies a retry/reset hint.

## 7. State model

Keep state intentionally small.

Each concrete route keeps:

```ts
state: "AVAILABLE" | "DRAINING" | "COOLDOWN"
freshness: "FRESH" | "STALE" | "UNKNOWN"
cooldownUntil?: number
reason?: string
lastSuccessAt?: number
lastFailureAt?: number
```

### AVAILABLE

No hard block is known and quota/runway looks normal.

### DRAINING

Route still works, but it should not receive new expensive work if a healthier substitute exists.

Triggers include:

- CodexBar `willLastToReset=false`;
- remaining quota below reserve;
- simple burn-rate projection says the quota will exhaust materially before reset.

Existing work can continue unless OMP itself needs to switch.

### COOLDOWN

Do not select until `cooldownUntil`.

Triggers include:

- quota exhausted;
- PAYG balance zero when the route is not free;
- hard 429 / usage-limit error;
- provider-supplied retry/reset timestamp.

If no timestamp exists, use a short bounded exponential cooldown and allow re-entry by real traffic/probe later.

## 8. Tier and class policy

The policy file contains semantic classes, not vendor routes.

### 8.1 Frontier

Order:

1. `fable-sub`
2. `astra-sub`
3. `opus-sub`
4. `opus-ish-sub`
5. `strong-flash-sub`
6. `strong-chinese`
7. `best-free`
8. graceful drain

Intent examples:

- `fable-sub`: direct Anthropic Fable subscription route.
- `astra-sub`: OpenAI Codex Astra subscription route.
- `opus-sub`: direct Anthropic Opus subscription route.
- `opus-ish-sub`: other healthy subscription frontier models.
- `strong-flash-sub`: strong fast subscription models.
- `strong-chinese`: DeepSeek V4 Pro, GLM-class strong models, and future peers.

### 8.2 Balanced

Order:

1. `sonnet-sub`
2. `luna-sub`
3. `chinese-flash-payg`
4. `free-chinese-flash`
5. `best-available`
6. `healthy-free`
7. graceful drain

Examples include DeepSeek V4.1 Flash and GLM 5.3 Flash.

### 8.3 Small

Order:

1. `cheap-sub`
2. `cheap-flash`
3. `healthy-free-fast`
4. graceful drain

Examples include Haiku-class, Luna/Spark-class when available, cheap Chinese flash models, and healthy free fast routes.

### 8.4 Pressure order

When shared capacity becomes scarce, stop admitting expensive new work in this order:

```text
frontier first → balanced next → small last
```

Do not kill an already-running task solely because it entered `DRAINING`. Prefer to finish the current atomic step and avoid new fan-out.

## 9. Candidate discovery and classification

On each refresh/session start:

1. Read authenticated routes from the current OMP model registry.
2. Normalize each model into a canonical family/model identity where possible.
3. Apply lightweight class match rules based on model id/name/tags/capabilities.
4. Join live telemetry only for routes that actually exist in OMP.
5. Ignore stale state for providers/routes no longer present.

Class rules live in configuration and support globs/regexes/tags. Provider names are not required unless a class specifically means a subscription route such as `fable-sub`.

Example conceptual policy:

```yaml
tiers:
  frontier:
    - class: fable-sub
    - class: astra-sub
    - class: opus-sub
    - class: opus-ish-sub
    - class: strong-flash-sub
    - class: strong-chinese
    - class: best-free

  balanced:
    - class: sonnet-sub
    - class: luna-sub
    - class: chinese-flash-payg
    - class: free-chinese-flash
    - class: best-available
    - class: healthy-free

  small:
    - class: cheap-sub
    - class: cheap-flash
    - class: healthy-free-fast
```

Adding/removing providers changes the OMP registry, not this topology.

## 10. Route selection algorithm

Tier/class order is the hard quality policy. Within the currently eligible class, choose routes using the agreed sequence.

### Stage A — cheapest healthy route

Eligible:

- `state == AVAILABLE`;
- no active cooldown;
- required balance/quota exists;
- telemetry is fresh enough or a recent real success exists.

Sort:

1. effective cost ascending;
2. quality/task-fit descending;
3. reliability descending;
4. latency ascending.

### Stage B — cheapest available route

If no healthy route exists, allow `DRAINING` or telemetry-unknown routes that are not hard-blocked.

Sort primarily by effective cost, then quality/reliability.

### Stage C — best available route

If cheap routes are unavailable or repeatedly fail, ignore price as the leading criterion and choose the highest-quality non-COOLDOWN candidate still allowed by the tier/class policy.

This is the survival path, not the normal operating path.

## 11. Cost / "best effort per buck"

### 11.1 Subscription/free marginal cost

Subscription routes and true free routes are treated as zero marginal-dollar cost **only while quota health is acceptable**. A scarce/draining subscription is not automatically preferred to a cheap healthy PAYG route.

### 11.2 PAYG route comparison

For the same/similar model, use the current OMP model catalog's provider-specific price fields. Balance only determines whether the route can pay for work; a large balance does not justify using a more expensive vendor.

Example from the current model catalog:

- GLM 5.3 Flash: OpenRouter is listed cheaper than Kilo.
- DeepSeek V4.1 Flash: OpenRouter and OpenCode Go are listed cheaper than Kilo for the same catalog model.

The extension therefore chooses the cheaper healthy concrete route when the model/class is otherwise equivalent.

### 11.3 Effective cost

Do not build a complex cost forecaster in v1.

Use a configurable weighted estimate from OMP's catalog prices:

```text
effectiveCost =
  wIn    * inputPrice
+ wOut   * outputPrice
+ wRead  * cacheReadPrice
+ wWrite * cacheWritePrice
```

Default weights should be derived once from recent OMP token mix and can be overridden. For identical models across vendors, the exact weights usually do not change ordering when all token-price components scale similarly.

## 12. Historical reliability and performance

OMP history is not an availability authority. It is a tie-break/scoring source.

Use rolling recent statistics such as:

- success rate;
- recent failure burst rate;
- TTFT;
- tokens/sec;
- actual observed cost where trustworthy.

A model that was historically reliable but is now quota-exhausted is still unavailable.

A model with a historically bad failure rate may still be tried if it is the only surviving route, but it should rank below peers in the same class.

## 13. CodexBar integration

Preferred integration:

- use CodexBar's local JSON/server interface rather than scraping the UI;
- cache snapshots for a short TTL;
- treat failures to query CodexBar as non-fatal;
- never enumerate provider inventory from CodexBar; join CodexBar telemetry onto OMP-discovered providers/routes.

Useful fields:

- usage windows and `resetsAt`;
- `usedPercent`;
- `pace.willLastToReset` and ETA;
- provider balance/credits;
- provider operational status;
- account identity only as an internal stable discriminator; never log email/token data.

### Multi-account handling

Quota/cooldown must be tracked at the narrowest available scope:

```text
provider → credential/account → quota window/tier
```

Two accounts on the same provider may have different reset times. Do not collapse them into a single provider-level cooldown when OMP/CodexBar exposes separate account state.

## 14. OpenRouter Data API integration

OpenRouter Data API is a **quality/task-fit intelligence source**, not a health source.

Reference:
- https://openrouter.ai/docs/cookbook/administration/data-api

### 14.1 Authentication and credential reuse

Reuse the same OpenRouter credential that OMP already resolves for the `openrouter` provider. The extension calls `ctx.modelRegistry.getApiKeyForProvider("openrouter", sessionId)` at refresh time, keeps the returned key in memory only for the request, and never logs or persists it. There is no separate Data API key setting and no direct read of OMP credential databases.

If no OpenRouter credential is resolvable, Data API intelligence becomes an optional missing signal; routing continues from OMP/CodexBar/local history.

### 14.2 Endpoints

Use:

- `/api/v1/benchmarks?source=artificial-analysis&task_type=coding`
- `/api/v1/benchmarks?source=artificial-analysis&task_type=agentic`
- optionally Design Arena coding results;
- `/api/v1/classifications/task?window=7d`
- optionally `/api/v1/datasets/rankings-daily` as a very low-weight popularity/tiebreak signal.

The API is authenticated with a normal OpenRouter key and currently documents shared limits of 30 requests/minute per key and 500/day per account. The extension should poll far less frequently, e.g. every 6–12 hours, with stale-if-error caching.

### 14.3 How scores are used

Inside one allowed class:

```text
qualityScore =
  benchmark coding signal
+ benchmark agentic signal
+ weak task-classification prior
+ local OMP reliability signal
```

Public rankings/popularity are weak tie-breakers only.

### 14.4 Safety boundaries

Data API may:

- reorder candidates inside `strong-chinese`, `chinese-flash`, `healthy-free-fast`, etc.;
- improve `best available` choice.

Data API may not:

- mark a model healthy/unhealthy;
- override a quota/cooldown veto;
- move a model between frontier/balanced/small boundaries;
- override explicit user class ordering.

If Data API is unavailable, routing continues using OMP/CodexBar/local history.

## 15. Free-route health and probing

Free routes often have tight rate limits, so active polling must be sparse.

Policy:

```text
real traffic success > cached health > probe
```

When a free route fails with a rate/quota-style error:

1. put that route on cooldown;
2. in the background, probe at most two alternate free aggregators/routes;
3. cache probe result for a short TTL (initially ~5 minutes);
4. do not repeatedly probe during the same failure burst;
5. after cooldown, prefer a real lightweight task as re-entry proof; use a probe only if needed.

Example behavior:

```text
OpenCode Go free fails
  ├─ background check Kilo Auto Free
  └─ background check OpenRouter free candidate/router
```

A failed probe must never block the foreground task.

## 16. Graceful drain

Do not expose raw quota percentages to the model unless necessary.

Inject one simple resource-pressure signal into new/continuing work:

```text
normal   — work normally
draining — finish current atomic step; reduce fan-out; do not start broad new branches
critical — validate/persist current progress; summarize remaining work; stop opening new phases
```

Internally, the router may still use only `AVAILABLE/DRAINING/COOLDOWN`; `critical` is a prompt-level behavior derived when the tier has almost no non-cooldown candidates left.

The signal should be short and stable so it does not dominate the agent prompt.

## 17. OMP extension responsibilities

### Must do

- discover current models/routes from OMP;
- infer workload tier from role/agent context;
- load the semantic class policy;
- fetch/cache OMP usage;
- fetch/cache CodexBar telemetry;
- fetch/cache OpenRouter Data API intelligence;
- maintain small in-memory/persisted cooldown state;
- rank candidates;
- call OMP model selection before new work when a better route exists;
- listen to retry/error events to update cooldown/health state;
- inject graceful-drain context when necessary;
- expose a human-readable status command for debugging.

### Must not do

- proxy inference traffic;
- own provider authentication;
- duplicate OMP's retry engine;
- parse/modify OMP credential stores directly;
- depend on `models.db` schema;
- treat CodexBar configuration errors as provider outages;
- make OpenRouter public benchmark data an availability oracle;
- require a fixed provider list.

## 18. Extension lifecycle

Suggested hooks:

### `session_start`

- seed current model registry snapshot;
- load small persisted health cache;
- refresh telemetry asynchronously;
- schedule safe managed refresh timers using `ctx.setInterval`.

### `before_agent_start`

- determine current tier/role;
- score candidates;
- if selected route differs, use OMP's model-selection action before the request starts;
- add a short drain-pressure context signal when needed.

### retry / provider-response events

- observe OMP `auto_retry_*` / fallback events and response errors;
- record hard cooldown only for explicit rate/quota/retry signals;
- a zero-delay quota retry without a model fallback is treated as likely native credential rotation/banked-reset recovery: record the failed attempt but do **not** blacklist the whole provider/model route;
- when OMP applies a model fallback, cooldown only the failed concrete route;
- provider retries do not run `before_agent_start`, so the current in-flight turn always remains owned by OMP's native retry/fallback engine; the extension's new cooldown affects later work;
- do not fight the in-flight native retry engine.

### `session_shutdown`

- flush tiny health/cooldown cache if persistence is enabled;
- managed timers are automatically cleared by OMP.

## 19. Persistence

Persist only small ephemeral operational state, e.g.:

```json
{
  "routes": {
    "openrouter/z-ai/glm-5.3-flash": {
      "cooldownUntil": 0,
      "lastSuccessAt": 0,
      "lastFailureAt": 0,
      "reason": null
    }
  }
}
```

Do not persist credentials, account emails, API keys, raw provider responses, or OMP internal model-registry objects.

Stale entries for removed routes are garbage-collected automatically.

## 20. Failure behavior

The extension is advisory and must fail open.

If any extension component fails:

```text
extension error / telemetry unavailable
        ↓
log warning
        ↓
leave current OMP model unchanged
        ↓
OMP native retry/fallback remains operational
```

This is the central reliability requirement: disabling/removing the extension must leave a usable native OMP setup.

## 21. Observability

Add one command, e.g. `/route-status`, showing:

```text
role/tier: balanced
selected: openrouter/z-ai/glm-5.3-flash
reason: cheapest healthy in chinese-flash-payg

health:
  anthropic/claude-sonnet-5   DRAINING   quota pace
  openai-codex/gpt-5.6-luna  COOLDOWN   reset 2026-09-19...
  openrouter/...              AVAILABLE  $ balance + fresh success

intel:
  OpenRouter Data API: fresh (age 3h)
  CodexBar: fresh (age 20s)
  OMP usage: fresh (age 8s)
```

Do not show credentials or unredacted account identifiers.

## 22. Acceptance criteria

1. Removing Kilo/OpenRouter/another provider from OMP does not crash routing and requires no config migration.
2. Adding a new provider that exposes a model matching an existing class makes it eligible automatically.
3. OMP-native usage exhaustion prevents proactive selection before a provider error.
4. A runtime 429 with retry/reset information removes the concrete route until the timer expires.
5. A CodexBar fetch error does not mark the provider unavailable.
6. Two Codex accounts with different reset times remain separate availability units.
7. An exhausted long window (e.g. weekly) vetoes a provider even if a short window is empty/healthy.
8. For equivalent model routes, lower current provider price wins when both are healthy.
9. OpenRouter benchmarks can change order inside a class but cannot change tier/class membership.
10. Free-model probes are event-driven, capped, background-only, and TTL cached.
11. When all routes for a tier become scarce, the agent gets a graceful drain instruction rather than an abrupt policy stop.
12. If the extension throws or all external telemetry is unavailable, native OMP operation continues.

## 23. Rollout

### Phase 1 — native OMP hardening

- enable `usageAwareFallback`;
- set reserve policy to `auto`;
- enable resolved-model badges;
- replace unsafe broad provider wildcard fallbacks with role/tier-oriented fallback chains.

This phase is useful even without the extension.

### Phase 2 — minimal router extension

Implement only:

- dynamic OMP model discovery;
- OMP usage + CodexBar join;
- three-state route health;
- tier/class rules;
- cheapest-healthy / cheapest-available / best-available selection;
- cooldown handling;
- `/route-status`.

### Phase 3 — intelligence and polish

Add:

- OpenRouter Data API cache/scoring;
- OMP historical reliability/latency scoring;
- event-driven free probing;
- graceful drain prompt signal.

This sequencing keeps v1 understandable and ensures each phase is independently useful.

## 24. Explicit non-goals

- automatic discovery of what "frontier" means from benchmarks;
- optimizer/ML model for quota forecasting;
- universal cross-provider billing engine;
- request proxying;
- rewriting OMP credential handling;
- continuous free-model pinging;
- complex hard per-tier budget partitions.

## 25. Final decision summary

The system is **OMP first, extension second**.

OMP remains the reliable executor and recovery engine. The extension is a small advisory scheduler that joins live quota, provider balance, catalog price, historical reliability, and cached public quality signals to choose a better model before work starts.

The routing policy is intentionally stable even when providers change:

```text
user tier/class order
      ↓
cheapest healthy route
      ↓
cheapest available route
      ↓
best available route
      ↓
graceful drain
```

Provider inventory is dynamic; tier semantics remain user-controlled.
