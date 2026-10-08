# BUG — OpenRouter Data API quota spent, every PMR ladder silently static

**Date:** 2026-10-09 · **Layer:** telemetry (OpenRouter intel cache) → `index.ts` wiring · **Fix:** `fix/shared-openrouter-intel-cache`

## Symptom

`pmr/frontier` ran `anthropic/claude-fable-5-1`. The user expected `claude-opus-5-5`, which costs less
($4/$20 against $10/$50 per Mtok). The question was whether the OpenRouter ratings, which reorder rungs
in the other tiers, applied to frontier at all.

They apply to every tier through the same code path (`rungs.ts` · `computeLadders`). On 2026-10-09 they
applied to **no** tier: the snapshot was empty and every ladder was the shipped `policy.yml` order.

## Reproduction

The extension's own `refreshOpenRouterIntel` was replayed against the live catalog (`omp models --json`),
live quota (`omp usage --redact --json`) and the same key OMP holds (`omp token openrouter`, used in memory only):

```
HTTP 429 benchmarks?source=artificial-analysis&task_type=coding
HTTP 429 benchmarks?source=artificial-analysis&task_type=agentic
HTTP 429 classifications/task?window=7d
{"error":{"message":"Rate limit exceeded: datasets-per-account-rpd-v1.
  Per-account limit of 500 requests/day exceeded for the OpenRouter Data API.","code":429}}
x-ratelimit-limit: 500   x-ratelimit-remaining: 0   x-ratelimit-reset: 1791504000000 (2026-10-09T00:00Z, the next UTC midnight)

refresh: intel keys 0
anthropic/claude-fable-5-1  fable-sub  AVAILABLE  power undefined
anthropic/claude-opus-5-5   opus-sub   AVAILABLE  power undefined
frontier ladder: static  fable-sub > astra-sub > opus-sub > …
pick: fable-sub anthropic/claude-fable-5-1
```

| Condition | Data API answer | Snapshot | Ladders (all four tiers) |
|---|---|---|---|
| Budget left (as designed) | 200 | populated | `snapshot` where ≥ 2 classes measured |
| Budget spent (live 2026-10-09) | 429 on all endpoints | empty | `static` |
| Any single endpoint 429 | `Promise.all` rejects | empty | `static` |

## Root cause

The account budget is 500 Data API requests/day. One refresh costs four. The cache that was supposed to
make this budget last (6 h TTL) lived **only in each process's memory**:

1. `let intel: IntelCache` in `index.ts` was never persisted. Every fresh OMP process (Multica and Hermes
   spawn one per attempt) started cold and spent four requests at `session_start`.
2. A failed refresh was retried after `INTEL_RETRY_FLOOR_MS` (15 min) regardless of the status. A 429 was
   treated like any transient error, so every live process kept spending four requests every 15 minutes:
   up to 384/day per process, against 500/day for the account. 36 `omp` processes were running at the time.
3. Once spent, the budget stayed spent: every retry hit 429 and nothing recorded that it would keep doing so.

## Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Frontier is excluded from the OpenRouter ratings. | **Disproved** | `computeLadders` derives all four tiers from one `profileClasses(routes)`; `rungs.test.ts` routes frontier from a snapshot. |
| H2 | The key is missing or wrong. | **Disproved** | Same key: `/api/v1/key` answers 200; the 429 body names the daily per-account Data API limit. |
| H3 | The ratings rank Fable above Opus 5.5. | **Unmeasurable today** | The snapshot is empty. The last saved one (2026-09-22) had no Opus 5.5 row; Fable 5.1 (0.728) beat Opus 5 (0.700). |
| H4 | Per-process in-memory caching spends the account budget. | **Confirmed** | Code above; 4 requests per cold process plus 4 per 15 min per live process during a failure. |
| H5 | A 429 is retried like a transient error. | **Confirmed** | `catch { return attempted }` dropped the status; the 15-minute floor was the only gate. |

## Fix boundary

- `openrouter-intel.ts`: a 429 sets `blockedUntil` from `X-RateLimit-Reset` (live: the next 00:00 UTC), or
  the next UTC day when the header is missing or not in the future. No request is made before it.
  `mergeIntelCache` combines a process's cache with a peer's: newer snapshot wins, the latest attempt and
  block apply. `onAttempt` lets the caller publish an attempt before its requests leave.
- `state.ts` · `IntelStore`: the cache, including `blockedUntil`, lives in `state.intel.json` beside
  `state.json`. Every save merges with the file and replaces it atomically. It is a separate file on
  purpose. The first live install put it in `state.json`, and the long-lived `omp --mode rpc-ui` processes
  that still ran the previous release (12 of them, listed by `install.sh`) rewrote `state.json` without the
  field within minutes. Old code never touches the new file.
- `index.ts`: `refreshIntel` starts from the shared cache, publishes the attempt, and persists the result.
  Ladders are derived **after** an in-flight telemetry refresh. A persisted snapshot is available
  instantly while `omp usage` takes seconds, and `*-sub` membership needs that telemetry. Deriving
  earlier would profile routes with no subscription class and pin the shipped order until the next snapshot.
- `status.ts`: `/route-status` shows `rate-limited until <ISO>` while a block applies.

Unchanged: ladder semantics, class membership, `selectForTier`, the 6 h TTL, the 15-minute retry floor, and
the key handling (I12: the key is still resolved from `ctx.modelRegistry` per refresh and never persisted).
Also unchanged, and out of scope: one failing endpoint still discards the other three.

## Guards

`extension/tests/intel-shared-cache.test.ts`, 6 tests. One of them also simulates an old-release process
rewriting `state.json` between two refreshes. Each mutation was applied to a clean tree, restored, and
turned at least one test red:

| Mutation | Red test |
|---|---|
| block gate removed | 429 blocks until reset |
| reset header ignored | 429 blocks until reset |
| past reset trusted | next UTC day |
| peer cache not read | snapshot reuse · 429 stops every process · refresh in flight |
| fetched snapshot not persisted | snapshot reuse |
| `IntelStore.save` without merge | stale view keeps the newer snapshot and block |
| ladder derived before telemetry | snapshot reuse |
| attempt not published before requests | refresh in flight not duplicated |

`rungs.test.ts` · `routedModel` now clears its scratch state and intel file per call: the snapshot is
persisted, so the second call would otherwise reuse the first call's empty snapshot.

## Live proof

Installed hashes equal the repo for every changed module (`install.sh --skip-warmup`). 15 long-lived
`omp --mode rpc-ui` processes on the old release kept running throughout and kept rewriting `state.json`
(`keys: ["routes","telemetry"]`).

| UTC | Fresh process | `state.intel.json` |
|---|---|---|
| 22:51:44 | `omp -p --model pmr/small` | created: `lastAttemptAt` 22:51:44, `blockedUntil` 2026-10-09T00:00Z (the header value) |
| 22:54:25 | same, 2.5 min later | unchanged: no attempt |
| 23:10:33 | same, 19 min later (past the 15-minute retry floor) | unchanged: the block, not the floor, held it |

`/route-status` in an interactive `pmr/frontier` session, `sources:` section:

```
OpenRouter Data API: unknown old · rate-limited until 2026-10-09T00:00:00.000Z
```

Before the fix, each of these processes would have spent four requests, and each live process another
four every 15 minutes.
