# OMP Adaptive Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small provider-agnostic OMP extension that proactively selects the best current model route by tier, health, quota runway, and effective price while leaving inference, auth, retry, credential rotation, and reactive fallback inside OMP.

**Architecture:** Native OMP remains the executor and recovery engine. A user-level TypeScript extension under `~/.omp/agent/extensions/adaptive-router/` reads OMP's authenticated model registry, OMP usage snapshots, CodexBar telemetry, local historical stats, and cached OpenRouter Data API intelligence, then calls OMP model selection before new work starts. The extension is fail-open and never proxies LLM traffic.

**Tech Stack:** OMP ExtensionAPI, TypeScript on Bun, OMP CLI JSON, CodexBar localhost JSON/CLI, OpenRouter Data API, YAML configuration, `bun test`.

**Spec:** `/mnt/data/2026-09-18-omp-adaptive-model-routing-design.md`

## Global Constraints

- No external inference proxy or extra network hop in the LLM request path.
- OMP owns auth, credential rotation, retry classification, fallback execution, and `Retry-After` handling.
- Extension failures must fail open: leave the current model unchanged and let native OMP continue.
- Provider/model inventory comes from `ctx.models.list()`; never hard-code a provider inventory.
- Never read or modify `~/.omp/agent/agent.db` or `models.db` directly.
- Reuse OMP's already-resolved OpenRouter credential for Data API calls; never store a duplicate OpenRouter key.
- OpenRouter Data API may reorder models only inside an allowed semantic class and never changes tier membership or availability.
- Availability planning precedence is OMP usage → CodexBar → recent local health; a fresh runtime 429/quota error is an immediate temporary veto.
- Telemetry unavailable means UNKNOWN, not unhealthy.
- Free-model probing is event-driven, background-only, capped at two alternates per failure burst, and cached for five minutes.
- Only managed OMP timers (`ctx.setInterval` / `ctx.setTimeout`) are used for background refresh work.
- Never log API keys, OAuth tokens, account emails, or unredacted credential identifiers.
- Pressure admission order is frontier first, balanced next, small last.
- Selection inside an eligible class is cheapest healthy route → cheapest available route → best available route → graceful drain.

---

## Target File Structure

```text
~/.omp/agent/extensions/adaptive-router/
├── index.ts
├── types.ts
├── policy.ts
├── telemetry.ts
├── openrouter-intel.ts
├── health.ts
├── ranking.ts
├── state.ts
├── policy.yml
└── tests/
    ├── policy.test.ts
    ├── telemetry.test.ts
    ├── openrouter-intel.test.ts
    ├── health.test.ts
    └── ranking.test.ts
```

Also modify:

```text
~/.omp/agent/config.yml
```

---

### Task 1: Harden native OMP retry and usage-aware fallback

**Files:**
- Modify: `~/.omp/agent/config.yml`

**Interfaces:**
- Consumes: current OMP settings.
- Produces: proactive quota protection and safe native fallback even when the extension is disabled.

- [ ] **Step 1: Back up config**

```bash
cp ~/.omp/agent/config.yml ~/.omp/agent/config.yml.pre-adaptive-router
```

- [ ] **Step 2: Apply these settings without deleting unrelated config**

```yaml
retry:
  enabled: true
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  maxRetries: 3
  maxDelayMs: 60000
  usageAwareFallback: true
  usageReservePct: 10
  usageReservePolicy: auto
  waitForUsageReset: false

task:
  showResolvedModelBadge: true
```

- [ ] **Step 3: Replace unsafe broad provider-wildcard fallback rules with role-oriented emergency chains**

Use the existing role names as the safety net:
- `plan` / `advisor`: frontier order.
- `default` / `task`: balanced order.
- `smol` / `tiny`: small order.

Do not use a rule such as `openai-codex/* -> anthropic/*` as the primary policy, because it can cross tier boundaries.

- [ ] **Step 4: Verify effective config**

```bash
omp config list --json > /tmp/omp-effective-config.json
jq '.retry, .task.showResolvedModelBadge' /tmp/omp-effective-config.json
```

Expected:
- `usageAwareFallback == true`
- `usageReservePolicy == "auto"`
- `waitForUsageReset == false`
- `showResolvedModelBadge == true`

- [ ] **Step 5: Commit if `~/.omp/agent` is versioned**

```bash
git -C ~/.omp/agent add config.yml
git -C ~/.omp/agent commit -m "config: enable proactive OMP usage fallback"
```

---

### Task 2: Build the provider-agnostic extension skeleton and class policy

**Files:**
- Create: `~/.omp/agent/extensions/adaptive-router/index.ts`
- Create: `~/.omp/agent/extensions/adaptive-router/types.ts`
- Create: `~/.omp/agent/extensions/adaptive-router/policy.ts`
- Create: `~/.omp/agent/extensions/adaptive-router/policy.yml`
- Test: `~/.omp/agent/extensions/adaptive-router/tests/policy.test.ts`

**Interfaces:**
- Consumes: `ctx.models.list()`, `ctx.models.current()`, role/agent context.
- Produces: normalized semantic classes and workload tiers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { classifyModelId, tierForRole } from "../policy";

describe("tierForRole", () => {
  test("maps OMP roles to workload tiers", () => {
    expect(tierForRole("plan")).toBe("frontier");
    expect(tierForRole("advisor")).toBe("frontier");
    expect(tierForRole("default")).toBe("balanced");
    expect(tierForRole("task")).toBe("balanced");
    expect(tierForRole("smol")).toBe("small");
    expect(tierForRole("tiny")).toBe("small");
  });
});

describe("classifyModelId", () => {
  test("classification follows model identity, not provider inventory", () => {
    expect(classifyModelId("vendor-a/deepseek-v4.1-flash")).toContain("chinese-flash");
    expect(classifyModelId("vendor-b/claude-sonnet-5")).toContain("sonnet");
  });
});
```

- [ ] **Step 2: Run test and confirm it fails**

```bash
cd ~/.omp/agent/extensions/adaptive-router
bun test tests/policy.test.ts
```

Expected: missing module/functions.

- [ ] **Step 3: Add shared types**

```ts
export type Tier = "frontier" | "balanced" | "small";
export type RouteState = "AVAILABLE" | "DRAINING" | "COOLDOWN";
export type Freshness = "FRESH" | "STALE" | "UNKNOWN";

export interface PriceVector {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RouteHealth {
  state: RouteState;
  freshness: Freshness;
  cooldownUntil?: number;
  reason?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface NormalizedRoute {
  key: string;
  provider: string;
  modelId: string;
  classes: string[];
  free: boolean;
  subscriptionLike: boolean;
  price: PriceVector;
  health: RouteHealth;
  qualityScore: number;
  reliabilityScore: number;
  latencyMs?: number;
}
```

- [ ] **Step 4: Implement deterministic role mapping and model-family tags**

```ts
import type { Tier } from "./types";

export function tierForRole(role: string | undefined): Tier {
  if (role === "plan" || role === "advisor" || role === "slow") return "frontier";
  if (role === "smol" || role === "tiny") return "small";
  return "balanced";
}

export function classifyModelId(selector: string): string[] {
  const s = selector.toLowerCase();
  const out = new Set<string>();

  if (s.includes("fable")) out.add("fable");
  if (s.includes("astra")) out.add("astra");
  if (s.includes("opus")) out.add("opus");
  if (s.includes("sonnet")) out.add("sonnet");
  if (s.includes("haiku") || s.includes("spark")) out.add("cheap-sub");
  if (s.includes("luna")) out.add("luna");

  if (s.includes("deepseek") || s.includes("glm") || s.includes("qwen") || s.includes("kimi")) {
    out.add("chinese");
  }
  if (s.includes("flash")) {
    out.add("flash");
    if (out.has("chinese")) out.add("chinese-flash");
  }
  if (s.includes("deepseek-v4-pro") || s.includes("glm-5") || s.includes("qwen3-max")) {
    out.add("strong-chinese");
  }
  if (s.endsWith(":free") || s.includes("/free") || s.includes("auto-free")) out.add("free");

  return [...out];
}
```

- [ ] **Step 5: Add initial policy**

```yaml
tiers:
  frontier:
    classes: [fable-sub, astra-sub, opus-sub, opus-ish-sub, strong-flash-sub, strong-chinese, best-free]
  balanced:
    classes: [sonnet-sub, luna-sub, chinese-flash-payg, free-chinese-flash, best-available, healthy-free]
  small:
    classes: [cheap-sub, cheap-flash, healthy-free-fast]

agentTiers:
  architect: frontier
  reviewer: frontier
  scout: small
  librarian: small
```

- [ ] **Step 6: Add extension entry point**

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function adaptiveRouter(pi: ExtensionAPI) {
  pi.setLabel("Adaptive Model Router");

  pi.on("session_start", async (_event, ctx) => {
    pi.logger.info("adaptive-router started", { models: ctx.models.list().length });
  });
}
```

- [ ] **Step 7: Run tests**

```bash
bun test tests/policy.test.ts
```

Expected: PASS.

---

### Task 3: Add OMP usage and CodexBar telemetry

**Files:**
- Create: `~/.omp/agent/extensions/adaptive-router/telemetry.ts`
- Test: `~/.omp/agent/extensions/adaptive-router/tests/telemetry.test.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/index.ts`

**Interfaces:**
- Consumes:
  - `omp usage --redact --json`
  - `GET http://127.0.0.1:8080/usage?provider=all`
  - CLI fallback `codexbar usage --provider all --format json --status`
- Produces: normalized provider/account/window health telemetry.

- [ ] **Step 1: Write tests for multi-window and missing-telemetry behavior**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeCodexBarProvider } from "../telemetry";

describe("normalizeCodexBarProvider", () => {
  test("weekly exhaustion blocks despite a healthy 5h window", () => {
    const row = {
      provider: "opencodego",
      usage: {
        primary: { usedPercent: 0, resetsAt: "2026-09-18T22:53:40Z", windowMinutes: 300 },
        secondary: { usedPercent: 100, resetsAt: "2026-09-21T00:00:00Z", windowMinutes: 10080 },
        tertiary: { usedPercent: 50, resetsAt: "2026-10-16T07:31:45Z", windowMinutes: 43200 }
      }
    };
    const x = normalizeCodexBarProvider(row as any);
    expect(x.exhausted).toBe(true);
    expect(x.blockedUntil).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });

  test("fetch strategy errors mean unknown telemetry, not outage", () => {
    const x = normalizeCodexBarProvider({
      provider: "openai",
      error: { message: "No available fetch strategy for openai." }
    } as any);
    expect(x.telemetryAvailable).toBe(false);
    expect(x.exhausted).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
bun test tests/telemetry.test.ts
```

- [ ] **Step 3: Implement CodexBar normalization**

Normalize only:
- `provider`
- `telemetryAvailable`
- `exhausted`
- `draining`
- `blockedUntil`
- balance/credit availability when present
- timestamp/source

Do not retain emails or raw credential identifiers.

- [ ] **Step 4: Fetch CodexBar server-first with CLI fallback**

```ts
export async function fetchCodexBarUsage(pi: any) {
  try {
    const res = await fetch("http://127.0.0.1:8080/usage?provider=all", {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return await res.json();
  } catch {}

  const result = await pi.exec(
    "codexbar",
    ["usage", "--provider", "all", "--format", "json", "--status"],
    { timeout: 30_000 },
  );
  if (result.code !== 0) return [];
  return JSON.parse(result.stdout);
}
```

- [ ] **Step 5: Fetch OMP usage through the public CLI JSON boundary**

```ts
export async function fetchOmpUsage(pi: any) {
  const result = await pi.exec(
    "omp",
    ["usage", "--redact", "--json"],
    { timeout: 30_000 },
  );
  if (result.code !== 0) return [];
  return JSON.parse(result.stdout);
}
```

Do not query `agent.db` or model DBs.

- [ ] **Step 6: Implement source precedence**

When OMP and CodexBar describe the same meter:
1. use OMP's value;
2. use CodexBar for missing pace/reset/balance detail;
3. if neither source has data, mark freshness `UNKNOWN` and fail open.

- [ ] **Step 7: Refresh on managed timers**

- OMP TTL: 30 seconds.
- CodexBar TTL: 30 seconds.
- last-good stale allowance: 5 minutes.

Use `ctx.setInterval`, not raw timers.

- [ ] **Step 8: Run tests**

```bash
bun test tests/telemetry.test.ts
```

Expected: PASS.

---

### Task 4: Reuse the existing OMP OpenRouter credential and add Data API intelligence

**Files:**
- Create: `~/.omp/agent/extensions/adaptive-router/openrouter-intel.ts`
- Test: `~/.omp/agent/extensions/adaptive-router/tests/openrouter-intel.test.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/index.ts`

**Interfaces:**
- Consumes: `ctx.modelRegistry.getApiKeyForProvider("openrouter", sessionId)`.
- Produces: cached per-model coding/agentic/task-fit/popularity scores.
- Security: no second key, no DB scraping, no key logging.

- [ ] **Step 1: Write the auth-header test**

```ts
import { describe, expect, test } from "bun:test";
import { buildOpenRouterHeaders } from "../openrouter-intel";

test("uses OMP-resolved OpenRouter key as bearer auth", () => {
  expect(buildOpenRouterHeaders("sk-or-test")).toEqual({
    Authorization: "Bearer sk-or-test",
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test tests/openrouter-intel.test.ts
```

- [ ] **Step 3: Implement key reuse**

```ts
export function buildOpenRouterHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function resolveOpenRouterKey(ctx: any): Promise<string | undefined> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter", sessionId);
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
```

Do not introduce `OPENROUTER_DATA_API_KEY` or a second stored credential.

- [ ] **Step 4: Implement Data API fetches with the same key**

Fetch:

```text
GET https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding
GET https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=agentic
GET https://openrouter.ai/api/v1/classifications/task?window=7d
GET https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=<7d-ago>&end_date=<yesterday>
```

HTTP helper:

```ts
async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    headers: buildOpenRouterHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenRouter Data API HTTP ${res.status}`);
  return await res.json() as T;
}
```

- [ ] **Step 5: Cache for six hours with stale-if-error**

Behavior:
- success replaces cache;
- failure preserves last-good cache;
- no OpenRouter key returns empty intelligence;
- failed refresh cannot retry more often than once every 15 minutes;
- regular refresh is every 6 hours.

- [ ] **Step 6: Normalize only quality/task-fit data**

```ts
export interface ModelIntel {
  coding?: number;
  agentic?: number;
  taskFit?: number;
  popularity?: number;
}
```

Do not emit health, quota, or tier membership from this module.

- [ ] **Step 7: Run tests**

```bash
bun test tests/openrouter-intel.test.ts
```

Expected: PASS.

---

### Task 5: Implement health state, cooldowns, and persistence

**Files:**
- Create: `~/.omp/agent/extensions/adaptive-router/health.ts`
- Create: `~/.omp/agent/extensions/adaptive-router/state.ts`
- Test: `~/.omp/agent/extensions/adaptive-router/tests/health.test.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/index.ts`

**Interfaces:**
- Consumes: normalized usage plus OMP retry events.
- Produces: `AVAILABLE | DRAINING | COOLDOWN`.

- [ ] **Step 1: Write state-machine tests**

```ts
import { describe, expect, test } from "bun:test";
import { evaluateUsageHealth } from "../health";

test("exhaustion becomes cooldown until reset", () => {
  const h = evaluateUsageHealth({
    exhausted: true,
    blockedUntil: 1_800_000,
    draining: false,
    telemetryAvailable: true,
  }, 1_000_000);
  expect(h.state).toBe("COOLDOWN");
  expect(h.cooldownUntil).toBe(1_800_000);
});

test("bad runway becomes draining", () => {
  const h = evaluateUsageHealth({
    exhausted: false,
    draining: true,
    telemetryAvailable: true,
  }, 1_000_000);
  expect(h.state).toBe("DRAINING");
});

test("unknown telemetry fails open", () => {
  const h = evaluateUsageHealth({
    exhausted: false,
    draining: false,
    telemetryAvailable: false,
  }, 1_000_000);
  expect(h.state).toBe("AVAILABLE");
  expect(h.freshness).toBe("UNKNOWN");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test tests/health.test.ts
```

- [ ] **Step 3: Implement only three internal states**

Rules:
- exhausted quota, zero paid balance, or explicit rate-limit timer → `COOLDOWN`.
- `willLastToReset == false`, low reserve, or bad burn-rate runway → `DRAINING`.
- otherwise → `AVAILABLE`.
- missing telemetry → `AVAILABLE/UNKNOWN`.

- [ ] **Step 4: Listen to OMP retry events without fighting native retry**

```ts
pi.on("auto_retry_start", async (event, ctx) => {
  // event contains attempt, maxAttempts, delayMs, errorMessage, errorId?
});
```

If `errorMessage` is clearly rate/quota-related:
- when OMP emitted `retry_fallback_applied`, cooldown the failed `from` route and preserve OMP's selected `to` route for the current turn;
- when the retry delay is `0` and no model fallback was emitted, treat it as likely native credential rotation/banked-reset recovery: record a failure but do not cooldown the whole provider/model route;
- when OMP is waiting with a positive delay and no model fallback, cooldown the concrete route for future work using the provider/retry timer.

Provider retries do **not** fire `before_agent_start`; the extension never attempts to take over the in-flight retry. The cooldown changes later routing decisions only.

For isolated network/5xx errors:
- record a failure for reliability scoring;
- do not create a long quota cooldown.

- [ ] **Step 5: Persist tiny operational state**

File:

```text
~/.omp/agent/extensions/adaptive-router/state.json
```

Schema:

```json
{
  "routes": {
    "provider/model": {
      "cooldownUntil": 0,
      "lastSuccessAt": 0,
      "lastFailureAt": 0,
      "reason": null
    }
  }
}
```

Never persist credentials, account emails, or raw API responses.

- [ ] **Step 6: Garbage-collect removed routes**

At session start, compare stored route keys with `ctx.models.list()`. Drop stale entries for routes absent from OMP and older than 24 hours.

- [ ] **Step 7: Run tests**

```bash
bun test tests/health.test.ts
```

Expected: PASS.

---

### Task 6: Implement cost/quality ranking and model switching

**Files:**
- Create: `~/.omp/agent/extensions/adaptive-router/ranking.ts`
- Test: `~/.omp/agent/extensions/adaptive-router/tests/ranking.test.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/index.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/policy.ts`

**Interfaces:**
- Consumes: current OMP models, class policy, route health, OMP price metadata, OpenRouter intelligence.
- Produces: one concrete route per new work item.

- [ ] **Step 1: Write ranking tests**

```ts
import { expect, test } from "bun:test";
import { selectWithinClass } from "../ranking";

const base = {
  modelId: "deepseek-v4.1-flash",
  classes: ["chinese-flash"],
  subscriptionLike: false,
  free: false,
  qualityScore: 0.8,
  reliabilityScore: 0.9,
};

test("chooses cheapest healthy equivalent route", () => {
  const routes: any[] = [
    { ...base, key: "kilo/deepseek-v4.1-flash", provider: "kilo",
      price: { input: 0.30, output: 1.20 },
      health: { state: "AVAILABLE", freshness: "FRESH" } },
    { ...base, key: "openrouter/deepseek-v4.1-flash", provider: "openrouter",
      price: { input: 0.15, output: 0.60 },
      health: { state: "AVAILABLE", freshness: "FRESH" } },
  ];
  expect(selectWithinClass(routes)?.key).toBe("openrouter/deepseek-v4.1-flash");
});

test("healthy beats cheaper draining", () => {
  const routes: any[] = [
    { ...base, key: "cheap/draining", provider: "cheap",
      price: { input: 0.01, output: 0.02 },
      health: { state: "DRAINING", freshness: "FRESH" } },
    { ...base, key: "healthy/costlier", provider: "healthy",
      price: { input: 0.02, output: 0.04 },
      health: { state: "AVAILABLE", freshness: "FRESH" } },
  ];
  expect(selectWithinClass(routes)?.key).toBe("healthy/costlier");
});

test("cooldown route is never selected", () => {
  const routes: any[] = [
    { ...base, key: "dead/model", provider: "dead",
      price: { input: 0, output: 0 },
      health: { state: "COOLDOWN", freshness: "FRESH" } },
  ];
  expect(selectWithinClass(routes)).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test tests/ranking.test.ts
```

- [ ] **Step 3: Implement effective cost**

```ts
const MIX = { input: 1.0, output: 0.35, cacheRead: 4.0, cacheWrite: 0.05 };

export function effectiveCost(route: any): number {
  if (route.free) return 0;
  const p = route.price;
  return (
    MIX.input * (p.input ?? Number.POSITIVE_INFINITY) +
    MIX.output * (p.output ?? Number.POSITIVE_INFINITY) +
    MIX.cacheRead * (p.cacheRead ?? 0) +
    MIX.cacheWrite * (p.cacheWrite ?? 0)
  );
}
```

Unknown PAYG cost is not Stage-A/B cheap; it remains eligible for Stage C.

- [ ] **Step 4: Implement exact stage order**

1. cheapest `AVAILABLE`;
2. cheapest non-`COOLDOWN`;
3. best non-`COOLDOWN` by quality/reliability/latency;
4. no candidate → graceful drain.

Within a class, OpenRouter Data API may affect only quality ordering.

- [ ] **Step 5: Build candidates only from `ctx.models.list()`**

For each model:
- selector is `provider/id`;
- classify semantic identity;
- read OMP price metadata;
- join OMP/CodexBar health;
- join local reliability;
- join OpenRouter intelligence by canonical model identity.

No provider list is compiled into code.

- [ ] **Step 6: Switch only at `before_agent_start`**

```ts
pi.on("before_agent_start", async (_event, ctx) => {
  const selected = await chooseRouteForCurrentWork(ctx);
  if (!selected) return;

  const target = ctx.models.resolve(selected.key);
  const current = ctx.models.current();
  const currentKey = current ? `${current.provider}/${current.id}` : undefined;

  if (target && currentKey !== selected.key) {
    await pi.setModel(target);
  }
});
```

Do not switch continuously during tool-only continuations.

- [ ] **Step 7: Preserve sticky behavior**

The selected model stays for the running work until:
- another new user-containing batch fires `before_agent_start`, or
- native OMP retry/fallback switches because the current route actually failed.

- [ ] **Step 8: Run ranking tests**

```bash
bun test tests/ranking.test.ts
```

Expected: PASS.

---

### Task 7: Add free-route probing, graceful drain, `/route-status`, and final verification

**Files:**
- Modify: `~/.omp/agent/extensions/adaptive-router/index.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/health.ts`
- Modify: `~/.omp/agent/extensions/adaptive-router/ranking.ts`
- Test: all tests in `~/.omp/agent/extensions/adaptive-router/tests/`

**Interfaces:**
- Consumes: free-route failures and tier-wide scarcity.
- Produces: bounded recovery probing, resource-pressure context, and redacted diagnostics.

- [ ] **Step 1: Implement event-driven free probe suppression**

Constants:

```ts
const FREE_PROBE_TTL_MS = 5 * 60_000;
const MAX_FREE_PROBES_PER_BURST = 2;
```

On a real free-route rate/quota failure:
1. cooldown that route;
2. select at most two alternate free routes from the current OMP registry;
3. schedule background checks with `ctx.setTimeout(..., 0)`;
4. never await probes on the foreground path;
5. do not probe again within five minutes for the same failure burst.

Prefer recent real success over probing.

- [ ] **Step 2: Keep probes protocol-safe**

If OMP does not expose a safe minimal request for a concrete free route, do not invent private provider HTTP calls. Mark the alternate as `UNKNOWN` and let the next real lightweight task become the re-entry proof.

- [ ] **Step 3: Add pressure signaling**

Derive:
- `normal`: a healthy candidate exists.
- `draining`: only degraded/non-cooldown candidates remain.
- `critical`: only survival candidate(s) remain.

Add short context only when needed:

```text
[resource-pressure: draining]
Finish the current atomic step, reduce new fan-out, and avoid opening broad new work branches.
```

```text
[resource-pressure: critical]
Validate and persist current progress, summarize remaining work, and avoid starting a new phase.
```

Do not include raw percentages or balances in the prompt.

- [ ] **Step 4: Apply admission order under shared scarcity**

Stop admitting new expensive work in this order:

```text
frontier → balanced → small
```

Do not kill already-running work solely because it entered `DRAINING`.

- [ ] **Step 5: Add `/route-status`**

Output only redacted operational data:

```text
tier: balanced
selected: openrouter/z-ai/glm-5.3-flash
reason: cheapest healthy in chinese-flash-payg

health:
  anthropic/claude-sonnet-5    DRAINING   quota pace
  openai-codex/gpt-5.6-luna   COOLDOWN   until <timestamp>
  openrouter/...               AVAILABLE  fresh telemetry

sources:
  OMP usage: fresh
  CodexBar: fresh
  OpenRouter Data API: 2h old
```

Account rows use opaque labels such as `codex#1`, never email addresses.

- [ ] **Step 6: Run full unit suite**

```bash
cd ~/.omp/agent/extensions/adaptive-router
bun test
```

Expected: all tests PASS.

- [ ] **Step 7: Verify current real-world conditions**

Expected from the supplied telemetry:
- exhausted Codex accounts are not proactively selected until their own reset times;
- Claude may be `DRAINING` when CodexBar pace predicts it will run out before reset;
- OpenCode Go weekly exhaustion blocks it even though the 5h window is unused;
- OpenRouter paid routing is blocked when balance is `$0`;
- free OpenRouter models are evaluated separately from paid balance.

- [ ] **Step 8: Verify add/remove provider resilience**

Disable/remove a provider in OMP and restart.

Expected:
- no extension crash;
- route disappears from candidates;
- no policy migration.

Add/re-enable a provider with a model matching an existing class.

Expected:
- the route becomes eligible automatically.

- [ ] **Step 9: Verify fail-open rollback**

Temporarily set:

```yaml
disabledExtensions:
  - extension-module:adaptive-router
```

Restart OMP.

Expected: native OMP roles, retry, usage-aware fallback, and fallback chains still work.

- [ ] **Step 10: Check logs for leaked secrets**

```bash
grep -R -E 'sk-or-|Authorization: Bearer|accountEmail|signedInEmail' ~/.omp/logs | tail -n 50
```

Expected: no new adaptive-router line contains credentials or account emails.

- [ ] **Step 11: Commit**

```bash
git -C ~/.omp/agent add config.yml extensions/adaptive-router
git -C ~/.omp/agent commit -m "feat: add adaptive OMP model routing"
```

---

## Self-Review

### Spec coverage
- Native OMP usage-aware fallback: Task 1.
- Dynamic provider discovery: Tasks 2 and 6.
- OMP usage + CodexBar precedence: Task 3.
- Reuse of the exact OpenRouter key already configured in OMP: Task 4.
- AVAILABLE/DRAINING/COOLDOWN: Task 5.
- Cheapest healthy → cheapest available → best available: Task 6.
- Data API ranking only inside classes: Tasks 4 and 6.
- Sticky routing: Task 6.
- Event-driven free health handling: Task 7.
- Graceful drain and frontier→balanced→small admission pressure: Task 7.
- Redacted diagnostics and fail-open rollback: Task 7.

### Security consistency
The Data API client obtains the current OpenRouter provider credential through OMP's own `ModelRegistry`. No new secret is created, no credential database is parsed, and the key exists only in memory for authenticated requests.
