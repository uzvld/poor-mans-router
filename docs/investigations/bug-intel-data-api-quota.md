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

- `openrouter-intel.ts`: a 429 sets `blockedUntil` from `X-RateLimit-Reset` (live: the next 00:00 UTC),
  capped at one day. Without a usable reset, only a body naming the per-day quota (`…-rpd-…`) earns a
  block until the next UTC day; any other 429 is left to the 15-minute retry floor. `intelRefreshDue` is
  the gate (block, 6 h TTL, retry floor), and `fetchOpenRouterIntel` spends one refresh. `mergeIntelCache`
  combines caches (newer snapshot, latest attempt, latest block). `boundIntelBlock` drops an expired block
  and caps an implausible one.
- `state.ts` · `IntelStore`: the cache lives in `state.intel.json` beside `state.json`. It is a separate
  file on purpose. The first live install put it in `state.json`, and the long-lived `omp --mode rpc-ui`
  processes still running the previous release (12 of them, listed by `install.sh`) rewrote `state.json`
  without the field within minutes. Old code never touches the new file.
  - Every save merges with the file, bounds the block, and replaces the file atomically.
  - `read()` rejects anything other than a map of model objects and bounds the block, so a corrupt file
    can neither block forever nor crash `/route-status`.
  - `claim()` is an exclusive-create lock file (`state.intel.json.lock`, aged by mtime, reclaimed after
    60 s) that gives one process at a time the right to spend a refresh. When the lock cannot be used at
    all, the refresh goes ahead unshared.
- `index.ts`:
  - `refreshIntel` reads the shared file, resolves the key, takes the claim, then re-reads and
    re-checks before it spends anything. The re-check catches a peer that finished in between, and also
    this process's own concurrent refresh, because the session-start and first-turn timers can fire
    together.
  - A process without a key records nothing.
  - Persistence is best-effort: an unwritable file costs the sharing, never the snapshot.
  - Ladders are derived **after** an in-flight telemetry refresh. A persisted snapshot is available
    instantly while `omp usage` takes seconds, and `*-sub` membership needs that telemetry.
- `status.ts`: `/route-status` shows `rate-limited until <ISO>` while a block applies.
- `tests/preload.ts` (via `extension/bunfig.toml`) points `PMR_STATE_FILE` at a per-process scratch
  path. Suites that never set it used to read and write the developer's real `extension/state.json`;
  with the default removed, running `index-wiring` and `first-turn-latency` alone created that file.

Unchanged: ladder semantics, class membership, `selectForTier`, the 6 h TTL, the 15-minute retry floor, and
the key handling (I12: the key is still resolved from `ctx.modelRegistry` per refresh and never persisted).
Also unchanged, and out of scope: one failing endpoint still discards the other three.

## Guards

`extension/tests/intel-shared-cache.test.ts`, 18 tests. Two of them simulate, respectively, an
old-release process rewriting `state.json` and a peer landing a snapshot while this process resolves its
key. Each mutation was applied to a clean tree, restored, and turned at least one test red:

| Mutation | Red test |
|---|---|
| block gate removed | 429 blocks until reset |
| reset header ignored | 429 blocks until reset |
| past reset trusted | daily quota → next UTC day |
| peer cache not read | snapshot reuse · 429 stops every process · refresh in flight |
| fetched snapshot not persisted | snapshot reuse |
| `IntelStore.save` without merge | stale view keeps the newer snapshot and block |
| ladder derived before telemetry | snapshot reuse |
| claim ignored | live claim holds a process off |
| stale claim never reclaimed | stale claim reclaimed · unusable lock |
| unusable lock blocks instead of proceeding | session-start + first-turn together |
| no re-check after the claim | snapshot landed during key resolution |
| attempt not marked before fetching | session-start + first-turn together |
| keyless process publishes an attempt | keyless process does not hold back a keyed one |
| persistence throws | unwritable intel file |
| header block uncapped | implausible block bounded |
| file block uncapped | implausible block bounded |
| every 429 blocks for a day | non-daily 429 without reset |
| expired block kept | expired block dropped |
| loose `data` validation (twice) | file rejects data that is not a model map |
| future `fetchedAt` kept | future-dated file does not wedge refreshes |
| future `lastAttemptAt` kept | future-dated file does not wedge refreshes |
| release ignores the owner token | stalled holder does not release a peer's claim |
| claim never released | snapshot reuse · 429 stops every process (lock gone after refresh) |

The same-tick test (three processes) passes with any one of claim, re-check, or attempt mark in place,
because in one JS thread they overlap. Each of them is pinned by its own scenario above.

Known limits, left as they are:
- Two peers reclaiming the same stale lock can both get in. The re-check under the claim stops a
  duplicate spend, because the stale holder persisted its attempt first. The reviewer's probe (8 real
  processes, 18 rounds) spent exactly 4 requests every round.
- A process that loses the claim derives no ladder until its next refresh (next turn, or the 15-minute
  interval). A one-turn `omp -p` run therefore keeps the shipped order for that turn. That is no
  regression: a cold process was static before.

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

### After the quota reset (review fixes installed, 2026-10-09 07:29Z)

- One snapshot landed in `state.intel.json` at 07:29:23Z: 182 models, no block.
- A fresh process started 15 s later reused it, and `fetchedAt` stayed unchanged.
- Ladders replayed from that snapshot with the live catalog and quota:
  - `frontier`: `snapshot`, `fable-sub > opus-sub > astra-sub > opus-ish-sub`, pick `claude-fable-5-1`.
  - `balanced` and `small`: `snapshot`.
  - `free`: `static`.
- Frontier powers: `fable-sub` 0.728, `opus-sub` 0.700, `astra-sub` 0.674.
- `anthropic/claude-opus-5.5-20260921` is in the snapshot with **no** coding or agentic index. `opus-sub` is
  therefore measured by Opus 5, and Fable 5.1 ranks first on measurement, not by default.
