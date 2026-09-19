# Poor Man's Router

**Adaptive model routing for [oh-my-pi](https://github.com/nicepkg/oh-my-pi) (`omp`).**
Picks the cheapest model that is *good enough and actually available* for the work in front of it — using the subscriptions you already pay for before spending a cent on pay-as-you-go, and never sending new work to a model whose quota is about to run out.

```
                 ┌──────────────────────────────────────────────┐
  /model          │ current model is router/<tier>?              │
  pmr/balanced │   no  → manual: the router never touches it   │
       ──────────▶│   yes → mode  = frontier | balanced | small   │
                 │         class = first non-empty ladder rung   │
                 │         route = best model · cheapest seller  │
                 │         pi.setModel(route)                    │
                 └──────────────────────────────────────────────┘
                        ▲            ▲              ▲
                  omp usage     CodexBar       omp stats
                 (quota, auth)  (pace, wallet) (reliability, TTFT)
```

## Opt-in, never automatic

The router registers four **virtual models**. Selecting one is the only way to hand it the wheel:

| Selector | Meaning |
|---|---|
| `pmr/frontier` | managed routing, frontier ladder |
| `pmr/balanced` | managed routing, balanced ladder |
| `pmr/small` | managed routing, small ladder (cheap and fast, paid rungs included) |
| `pmr/free` | managed routing, **free-only** ladder — never spends |

They appear in `/model` and work at cold start (`omp --model pmr/balanced`). Once you pick one, the router switches the session to a concrete model each turn and announces it: `[omp:pmr] pmr/balanced -> kilo/… (reason)`.

**Selecting any real model is an explicit opt-out.** `/model anthropic/claude-sonnet-5` — or starting a session on any concrete model — puts that session in `manual` mode for good: no telemetry polling, no switches, nothing. Return with `/model pmr/balanced`.

Manual mode only silences *this* extension. OMP's own `retry.modelFallback` still handles 429s for the active turn.

For Multica-style spawners, set each agent's model to the tier it needs (`pmr/frontier`, `pmr/balanced`, `pmr/small`, `pmr/free`), or pin it to a concrete model to opt that agent out. No bootstrap mappings.

If a request ever reaches the virtual provider itself — meaning the router failed to switch away — the turn is aborted locally with a loud error instead of retrying against an unroutable endpoint.

## The four ladders

Each mode owns an ordered **class ladder**; the first class with a healthy candidate wins. Lower classes are never consulted while a higher class has a healthy route.

| Mode | Ladder (first match wins) |
|---|---|
| **Frontier** | `fable-sub → astra-sub → opus-sub → opus-ish-sub → strong-flash-sub → strong-chinese → best-free` |
| **Balanced** | `sonnet-sub → luna-sub → chinese-flash-payg → free-chinese-flash → best-available → healthy-free` |
| **Small** | `cheap-sub → cheap-flash → healthy-free-fast` |
| **Free** | `best-free → free-chinese-flash → healthy-free-fast → healthy-free` |

A class is a *semantic* bucket, not a model list: `sonnet-sub` = "any Sonnet reachable through a subscription credential". Models are classified by id pattern (`policy.ts`), then decorated by economics — `-sub` if the provider has a live subscription meter in `omp usage`, `-payg` if it's metered per token, `free` if the selector says so.

Ladders live in [`extension/policy.yml`](extension/policy.yml). Change them there; no code edit required.

## What "healthy" means

Route health is decided per **provider + model + quota window**, in this precedence:

1. **Local runtime cooldown** — a real 429 / quota error seen in this session. Hard veto until `Retry-After` expires.
2. **OMP usage** (`omp usage --json`) — the authoritative capacity signal. Exhausted window → `COOLDOWN`; inside the reserve (default 10 %) → `DRAINING`; otherwise `AVAILABLE`. Tier-scoped windows (e.g. a Fable-only weekly meter) only affect models of that tier.
3. **CodexBar** — used only when OMP has no report for the provider. Pace forecasts (`willLastToReset=false`) may mark a route `DRAINING`; a zero paid wallet blocks paid routes on OpenRouter/Kilo but never free ones.
4. **No telemetry** — `AVAILABLE`, freshness `UNKNOWN`.

A fresh, healthy OMP verdict always outranks a CodexBar burn-rate *forecast*. That rule exists because of [a real bug](docs/investigations/bug-d-sonnet-subscription-root-cause.md) where a pessimistic weekly forecast hid a 99 %-remaining Sonnet subscription behind a free DeepSeek route.

## Inside a class

When several routes share the winning class:

```
health (AVAILABLE first)
→ mode economics (speed for small, quality otherwise)
→ explicit quality / OpenRouter intel
→ measured reliability (unmeasured routes get a neutral 0.5, never a bonus)
→ same-family affinity: keep the model the session is already on
→ newer generation (claude-sonnet-5 ▸ claude-sonnet-4-6 ▸ claude-3-5-sonnet)
→ lexical id — last resort only
```

Then, for the winning *model*, the cheapest *seller* (Anthropic direct vs OpenRouter vs Kilo) is chosen by effective cost. Subscription and free routes cost 0.

## Install

Requires `omp` ≥ 18.2 and [Bun](https://bun.sh) (omp ships it).

```bash
git clone https://github.com/uzvld/poor-mans-router.git
cd poor-mans-router
./scripts/install.sh
```

The installer copies `extension/` to `$(omp config path)/extensions/adaptive-router/`, backs up anything already there, and sets the handful of `retry.*` keys in [`config/config-patch.yml`](config/config-patch.yml) so OMP's own retry/fallback engine stays in charge of the *current* turn. Your `modelRoles` and existing `fallbackChains` are never touched.

Restart `omp`. After the first turn, `/route-status` shows the decision.

`./scripts/uninstall.sh` removes the extension and restores the config backup.

### Optional

- **CodexBar** — install it for pace/wallet telemetry. The extension tries `http://127.0.0.1:8080/usage` first, then the `codexbar` CLI.
- **OpenRouter intel** — quality/agentic benchmarks and traffic rankings are fetched from the OpenRouter Data API using the `openrouter` credential OMP already holds. No key is copied or stored by this project.
- **Emergency fallback chains** — [`config/fallback-chains.example.yml`](config/fallback-chains.example.yml) is a starting point for `retry.fallbackChains`. Review against `omp models --json` before merging.

## Where things are

```
extension/          the OMP extension (TypeScript, loaded by Bun)
  index.ts            hooks: session_start · before_agent_start · before_provider_request · auto_retry_* · /route-status
  virtual-model.ts    pmr/* registration · routing-mode state machine
  policy.ts/.yml      class ladders, model-id classification
  ranking.ts          buildRoutes · selectForTier · in-class comparators
  health.ts           AVAILABLE / DRAINING / COOLDOWN from telemetry
  telemetry.ts        omp usage + CodexBar normalisation
  history.ts          omp stats → reliability / TTFT / throughput
  openrouter-intel.ts OpenRouter Data API → quality scores
  state.ts            persisted per-route cooldowns (state.json, gitignored)
  tests/              bun test — 94 tests, run from extension/
fixtures/           sanitised real telemetry snapshots the tests replay
config/             installer config patch · fallback-chain example
scripts/            install / uninstall / fixture sanitiser
docs/               design · implementation plan · investigations (root-cause reports)
```

## Development

```bash
cd extension && ln -sfn ../fixtures fixtures && bun test
```

Read [`AGENTS.md`](AGENTS.md) before changing routing behaviour — it defines the invariants every change must keep and the evidence a PR must carry. Every fix here has been a *proven* root cause first and a failing test second; keep it that way.

## Status

Live and in daily use on OMP 18.2.6. Known follow-ups are tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md).

This repo is public and has **no CI**: every check runs locally and is hash-attested (`scripts/secret-scan.sh`, see [`AGENTS.md`](AGENTS.md)). Clone → `git config core.hooksPath .githooks` before your first commit.

## License

MIT — see [`LICENSE`](LICENSE).
