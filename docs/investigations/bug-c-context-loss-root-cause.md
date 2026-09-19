# BUG C — Context loss on model switch: Root Cause Report

Installed OMP: `18.2.6`. Extension: `adaptive-router` (live, unmodified during this investigation).
Instrumentation: `tools/context-tracer/` — a standalone diagnostic OMP extension attached with `-e`, recording session/branch identity, stored-branch shape, and the **actual provider payload shape** on `before_provider_request`. It never logs content; the synthetic marker is reported as a boolean.

**No fix applied. No production behaviour modified.**

Artifacts: `docs/investigations/bug-c-context-trace.jsonl` (all case traces, JSONL, redacted), this report.

---

## Verdict

**The reported failure mode — "switching model in the same session loses context" — does NOT reproduce for any of: direct OMP switch, `pi.setModel()` (what the router calls), native 429 fallback, cross-provider switch, or a 30× context-window shrink.** In every case the session id, branch, stored history and **provider payload after the switch** all carry the marker, and the model answers correctly.

**A real, proven context-loss mechanism does exist, and it is not a switch at all.** It is OMP's **OpenAI remote (server-side) compaction** combined with a later switch to a model that cannot replay it. Evidence is in a real 3,300-entry Multica session on disk. Full chain below.

---

## Reproduction matrix

Every case: fresh OMP TUI session under `expect`, marker established on model A (3 turns), model switched, marker asked. `router=off` means `--no-extensions` (only the tracer loaded); `router=on` means the live adaptive-router was discovered and active.

| Case | router | switch mechanism | provider boundary | session id | stored history | marker in **provider payload** after switch | model answered marker |
|---|---|---|---|---|---|---|---|
| 0 control | off | none | — | 1 (`01a0b7d3`) | 7→30 entries, marker ✓ | ✓ (7 msgs) | ✓ |
| 1 same-provider | off | `pi.setModel` (`/ctx-switch`) | anthropic→anthropic (sonnet-5→sonnet-4-6) | 1 (`01a0b7d5`) | 18→20 across switch, marker ✓ | ✓ (7 msgs, model=sonnet-4-6) | ✓ |
| 3 router, no switch | **on** | router kept sonnet-5 | — | 1 (`01a0b7d6`) | marker ✓ | ✓ (6 msgs) | ✓ |
| 3b router forced | **on** | bootstrap=kilo free → router `setModel` → sonnet-5 | kilo→anthropic | 1 (`01a0b7d7`) | marker ✓ | ✓ every request | ✓ |
| 4+5 fallback+shrink | off | `pi.setModel` to 32k model → **compaction** → **429** → native fallback ×2 | anthropic→openrouter→openrouter | 1 (`01a0b7da`) | 25→40, marker ✓ through compaction | ✓ in **all 4** post-switch requests incl. both fallback models | ✓ |
| 6 Multica-style | off | new **process**, same `--session` file, `--model` changed | anthropic→anthropic | 1 (`01a0b7db`, both PIDs) | 11 entries resumed, marker ✓ | ✓ (3 msgs, model=sonnet-4-6) | ✓ |
| 7 cross-provider | off | `pi.setModel` | anthropic→kilo (deepseek free) | 1 (`01a0b7d5`) | 19→21, marker ✓ | ✓ (9 msgs) | ✓ |

Case 4+5 detail (the richest single trace):

```
seq  model                              stored  pl.msgs  pl.marker  event
 3   claude-sonnet-5                     24       5       ✓
     [ctx_switch] sonnet-5 → lfm-2.5-1.2b:free (32k)   stored 25→27  marker ✓→✓
 4   lfm-2.5-1.2b-thinking:free          33       7       ✓
     [session_compact]                                    stored 34   marker ✓   byType: compaction:1
 5   lfm-2.5-1.2b-thinking:free          35       5       ✓          ← post-compaction, 7→5 msgs, marker survived
     [retry_fallback_applied] lfm → ~deepseek-v4-flash-latest
 6   ~deepseek/deepseek-v4-flash-latest  38       5       ✓          ← native fallback request carries full history
     [retry_fallback_applied] deepseek → nemotron-3-ultra:free
 7   nvidia/nemotron-3-ultra:free        40       5       ✓
TUI: marker=ROUTER_CONTEXT_MARKER_71C9E4 animal=capybara number=48317
```

Case 6 is the Multica lifecycle exactly: Multica's daemon log (`~/.multica/daemon.log`, 340 task starts) shows it spawns `omp -p --mode json --session <file> [--model X]` per run and **never** uses `--resume`/`-c`. A second process with the same `--session` path and a different `--model` resumed the same session id, loaded 11 stored entries with the marker, and sent them.

---

## Hypothesis verdicts (from the task spec)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| A | OMP session/history is reset on switch | **DISPROVED** | One session id per case; stored entry count only grows across every switch (cases 1, 4+5, 7); marker present in stored branch before and after. |
| B | History exists but is not sent to the new model | **DISPROVED** | `before_provider_request` payload after every switch contains the marker; message counts consistent with history (7/9/5). |
| C | History truncated/compacted by a smaller-context target | **DISPROVED as loss; CONFIRMED as benign compaction** | Case 5: switching 1M→32k triggered `session_compact` (7→5 msgs); marker still in payload; model answered correctly. `snapcompact` preserves recent turns. |
| D | adaptive-router creates/replaces context | **DISPROVED** | `index.ts` `before_agent_start` returns `{ message: { customType: 'adaptive-router.resource-pressure', display:false } }` only when pressure ≠ normal — and OMP's `emitBeforeAgentStart` **appends** returned messages (`n.push`), it does not replace. Cases 3/3b with router live: identical payload shapes to router-off. Router calls only `pi.setModel`; grep confirms no `SessionManager`/`newSession`/`reset`/branch API use. |
| E | Native fallback takes a different session/branch | **DISPROVED** | Case 4+5: `retry_fallback_applied` ×2, same session id, leaf advances linearly, both fallback requests carry the marker. OMP's fallback (`#e.retryFallback…`) mutates `agent.state.model` and calls `scheduleAgentContinue({source:'automatic-retry'})` on the **same** agent state. |
| F | Multica restarts OMP with a new/ephemeral session | **DISPROVED** | Multica passes the same `--session` file every run; `-p --session <existing>` resumes (case 6: 2 PIDs, 1 session id, history carried). No `--no-session` in 340 spawns. |
| **G** | Something else | **CONFIRMED — see below** | |

---

## Root cause (G): OpenAI remote compaction is non-portable across providers

### The evidence — a real Multica session on disk

`~/.multica/pi-sessions/20260916T100923…jsonl` (3,300 entries, session `01a0a9b1`): 7 `model_change` entries, 8 `compaction` entries.

| idx | method | tokensBefore | tokensAfter | summary chars | what the summary contains |
|---|---|---|---|---|---|
| 419 | snapcompact | 28,776 | 64,164 | 714 | conversational summary |
| 685 | snapcompact | 20,259 | 81,505 | 1,997 | conversational summary |
| 886 | snapcompact | 16,168 | 73,697 | 1,983 | conversational summary |
| 1241 | snapcompact | 4,684 | 61,145 | 1,950 | conversational summary |
| **1956** | **remote** | **297,160** | 29,792 | **933** | `"Remote compaction preserved provider-native history for this session. Compaction processed 329855 input tokens."` + a `<files>` tree. **Nothing else.** |
| 2347 | remote | 261,072 | 34,917 | 933 | same shape |
| 2788 | remote | 257,233 | 58,515 | 933 | same shape |
| 3271 | remote | 239,926 | 40,387 | 933 | same shape |

The four `remote` compactions each folded ~250–300k tokens of conversation into a **933-character placeholder** whose only conversational content is one sentence. The real history is not in `summary`; it is in `preserveData.openaiRemoteCompaction.replacementHistory` — OpenAI Responses-API items (`providerReplayThroughEntryId` set on 2788/3271) that only an OpenAI Responses endpoint can consume. The model active at those compactions was `gpt-5.6-luna` (`openai-codex`), and the file shows the session bouncing between `cursor/cursor-grok-4.6` and `cursor/cursor-grok-4.6-fast` around them.

### The mechanism — OMP 18.2.6 code

Context assembly (`buildSessionContext`, strings @330395–330510) for the newest compaction entry `d`:

```js
const I = BL(d);                   // openaiRemoteCompaction.replacementHistory  (provider-native items)
const _ = I?.items;
…
if (!_ || o?.transcript) {         // ← replay NOT available → rebuild from firstKeptEntryId (normal path)
  …
} else if (d.providerReplayThroughEntryId) {   // ← replay available → send provider-native items
  …
}
```

and the eligibility gate (`Zue`, @317261):

```js
function $ue(e, t) {               // canReplayRemoteCompaction
  const s = xv(e) ?? xL(e);
  return !s || s.provider === t.provider && bL(t.api);
}
function bL(e) { return e === "openai-responses" || e === "azure-openai-responses" || e === "openai-codex-responses"; }
```

So:

1. While on `openai-codex` (Responses API) with `compaction.remoteEnabled`, OMP performs **remote** compaction: the provider keeps the conversation server-side; OMP stores `replacementHistory` and a one-line placeholder `summary`.
2. `Oot()` picks the last compaction whose `preserveData` is **replayable for the current model**: same provider **and** a Responses API.
3. After a switch to Anthropic / Cursor / Kilo / any non-Responses model, `$ue` → false, `BL(d).items` is unusable, and the builder falls into the `!_` branch: it emits the `summary` as a `compactionSummary` message and replays only entries from `firstKeptEntryId` onward.
4. That `summary` is the 933-char placeholder. **Everything before `firstKeptEntryId` — up to 1,832 messages in this file — is represented to the new model by one sentence and a file list.**

That is total context loss, by construction, and it is deterministic: it happens on the first request after any switch away from the Responses-API provider once a remote compaction exists in the branch.

### Why the matrix did not catch it

None of the matrix cases ran on `openai-codex` long enough (≥ ~250k tokens) to trigger a *remote* compaction. Case 5 triggered `snapcompact`, which writes a real summary and is provider-agnostic — hence it survived. The bug needs three things together: a Responses-API provider, a remote compaction, then a switch. The synthetic matrix satisfied at most two.

### Alternatives disproved

- **Not the router** — reproduces in a session file where the router's only footprint is `setModel`; cases 3/3b show router-on payloads identical in shape to router-off. The router does not touch compaction, `SessionManager`, or `preserveData`.
- **Not Multica process lifecycle** — case 6 proves same-file resume carries history; the daemon log proves no ephemeral flag is used.
- **Not context-window capacity** — case 5 shrank 1M→32k and kept the marker; the loss in the real file happened on models with ≥ 1M windows.
- **Not native fallback** — fallback requests in case 4+5 carry the full history.
- **Not history being unsent** — for `snapcompact`/no-compaction the payload contains the marker every time.

### Minimal fix boundary

**Not adaptive-router.** This is OMP core compaction policy (`compaction.remoteEnabled` / `Zue` / `buildSessionContext`). Two legitimate places to act, either is outside the router:

1. **OMP config** (user-level, immediate): `compaction.remoteEnabled: false` — forces `snapcompact`/summary compaction, which every provider can consume. Trade-off: local summarisation cost and quality vs server-side.
2. **OMP core** (upstream): when a remote compaction exists and the target of a model switch cannot replay it, generate a portable summary from `replacementHistory` *at switch time* (before the first non-replayable request) instead of substituting the placeholder.

What the **router** could do, without owning the fix: refuse — or warn on — a `setModel` away from a Responses-API provider when the current branch's newest compaction is `method: "remote"` and the target cannot replay it. That is a guard, not a fix; it belongs on the roadmap as such, and it must not be mistaken for the root-cause repair.

### Open items (not proven, flagged)

- Whether Cursor's `cursor-grok` endpoint counts as `openai-responses` in OMP's registry (it did not replay here, but the file also shows `openai-codex` as the compaction-time provider).
- The exact `compaction.remoteEnabled` default in 18.2.6 — the user's `config.yml` has no `compaction:` block, and the session file proves remote compaction ran, so the default is effectively **on** for `openai-codex`.

---

## Status

Root cause **proven for the real loss** (OpenAI remote compaction → non-replayable model). The originally hypothesised loss (switch resets/omits history) is **disproved** across 7 cases with provider-payload evidence. Fix boundary is OMP config/core, **not** adaptive-router. No code changed.
