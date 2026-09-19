# AGENTS.md — working in this repo

You are probably an AI agent. This file is the contract. Read it fully before editing anything under `extension/`.

## What this project is

An `oh-my-pi` extension that chooses a model for each agent turn. It is **installed into a live coding environment** and a wrong decision costs real money or burns a real subscription window. Treat every change to routing as production.

## Non-negotiable invariants

Tests exist for each of these. If your change needs one relaxed, that is a design decision for the human, not for you — stop and ask.

| # | Invariant | Guarded by |
|---|---|---|
| I1 | Class ladder order is absolute. A lower class is never selected while a higher class has an `AVAILABLE` route. | `ranking.test.ts` · `class order dominates quality` |
| I2 | A fresh OMP capacity verdict outranks any CodexBar pace forecast for the same provider. | `bug-d-sonnet-subscription.test.ts` |
| I3 | Real OMP exhaustion → `COOLDOWN`; inside reserve → `DRAINING`. The fix for I2 must never mask these. | `bug-d-sonnet-subscription.test.ts` · guards |
| I4 | Quota windows are independent scopes. A Fable-only meter cannot block Sonnet. | `health.test.ts` · `Fable scoped quota` |
| I5 | Local runtime cooldown (a real 429 seen in-session) is a hard veto regardless of telemetry. | `health.test.ts` · `local runtime cooldown` |
| I6 | Free routes on paid aggregators are not blocked by an empty paid wallet. | `health.test.ts` · `zero OpenRouter paid balance` |
| I7 | An unmeasured route never gets a reliability *bonus* over a measured one. | `in-class-winner.test.ts` |
| I8 | Current-model affinity is a tie-break only: same family, after economics/quality/reliability, never across families. | `in-class-winner.test.ts` · `index-affinity.test.ts` |
| I9 | Generation ordering is family-scoped. `qwen3` vs `trinity` must not be reordered by a digit. | `sonnet-tiebreak.test.ts` |
| I10 | `:batch` variants are never live candidates. | `ranking.test.ts` |
| I11 | The extension never creates a new session, branch, or `SessionManager`; it only calls `pi.setModel`. | `index-wiring.test.ts` |
| I12 | No secret is ever read from disk by this code. The OpenRouter key comes from `ctx.modelRegistry` at runtime and is never persisted. | `openrouter-intel.test.ts` |

## How to change routing behaviour

The order is fixed. Skipping a step is how the bugs in `docs/investigations/` happened.

1. **Reproduce with evidence, not a story.** Replay the installed modules against a real telemetry snapshot (see `scripts/fixture-simulation.test.ts` for the pattern). Capture `omp usage --redact --json`, `codexbar usage --provider all --format json`, `omp models --json`, `omp stats --json`. Run `scripts/sanitize-fixtures.py` on them before they touch git.
2. **Name the layer.** telemetry → health → classes → ladder → in-class comparator → `index.ts` wiring. One root cause per failure mode. "Probably" and "seems" are not allowed in the write-up.
3. **Check the design first.** `docs/design.md` documents intended behaviour. If the code matches the design and the design is wrong, that is a *policy change* — write it up in `docs/investigations/` and get a human decision before touching `ranking.ts` ladder semantics.
4. **RED first.** Write the failing test against the *current* code and watch it fail for the right reason. Then the minimal change. Then green. Then the full suite. Prove each new guard is red-capable by mutating the code it protects — a test that stays green under mutation tests nothing.
5. **Differential replay.** Compare selections for *all three tiers and every class* before/after on the same snapshot. Every changed line must be explained by the intended change. Unexplained flips (e.g. a free class reordering) are regressions — fix them before proposing.
6. **Live proof.** After install, one fresh `omp` session, `/route-status`, saved to a file. The model answering is not proof; the provider payload and the route decision are.

## Repo conventions

- **Runtime**: Bun. Tests: `bun run test` (unit, 67) and `bun run test:sim` (end-to-end snapshot). No build step; OMP loads `.ts` directly.
- **No CI, no GitHub Actions.** Actions are disabled on the repo. Every gate below runs **locally** and its result is attested by hash. Do not add a workflow file.
- **Fixtures** are sanitised real snapshots. Never commit raw `omp usage` / CodexBar / `omp stats` output — it contains account ids, emails and workspace ids. Always pass through `scripts/sanitize-fixtures.py` and check its "removed field paths" report.
- **`state.json`** is per-machine runtime state. It is gitignored. Do not add it, do not read it in tests.
- **Test files** live in `extension/tests/`, one behaviour per test, names describe behaviour not implementation. Live-snapshot regressions are named after the bug (`bug-d-*.test.ts`).
- **Investigations** are permanent. Each root-cause report in `docs/investigations/` includes: reproduction matrix, the hypothesis table with verdicts, alternatives disproved, minimal fix boundary. They are the reason the invariants above exist.
- **Deployment lock**: installs must be atomic and single-writer. See `docs/ROADMAP.md` · "deploy lock". Until it exists, never install from two agents at once, and re-verify installed hashes after every install.

## Secret & PII gate — this repo is PUBLIC

Nothing leaves this machine unscanned. This is enforced by hooks, and it is also **your contract** — hooks can be misconfigured, you cannot be.

**Setup (once per clone):** `git config core.hooksPath .githooks`. If `git config core.hooksPath` does not print `.githooks`, the gates are off — fix that before doing anything else.

**The gate:** `scripts/secret-scan.sh` — forbidden filenames, `gitleaks`, a regex set tuned to what *this* project leaks (emails, `wrk_` workspace ids, home paths, CodexBar identity fields, provider keys), and a check that every `fixtures/*.json` went through the sanitiser. On success it writes `.secret-scan.attest` with a hash over **the scanner + every scanned file**.

**Rules:**

1. `pre-commit` runs the gate on the staged set. `commit-msg` refuses any commit whose message lacks a `Secret-Scan: <attest>` trailer matching the staged set. `pre-push` refuses any remote outside `github.com/uzvld/` and re-scans the whole tree.
2. **Never use `--no-verify`, never edit `.githooks/`, never widen `ALLOW` in the scanner** to make a finding go away. If the scanner flags it, the content is wrong, not the scanner. Remove or sanitise, then re-scan.
3. Every commit message ends with the trailer, verbatim from the scan output:
   ```
   Secret-Scan: <attest>
   ```
   Every PR description quotes the same value so a reviewer can run `scripts/secret-scan.sh --verify <attest>` and prove the scan ran on exactly that tree with exactly that scanner.
4. Before adding **any** file that came from a real machine (telemetry, logs, `/route-status` output, session dumps, screenshots), run it through `scripts/sanitize-fixtures.py` or redact by hand, then run `scripts/secret-scan.sh <file>` on it alone and read the output.
5. If you find a secret already in history: **stop, do not push, do not "fix it in a follow-up commit".** Report the file and category (never the value) to the human. History rewriting is a human decision.
6. `gitleaks` missing locally → `brew install gitleaks`. The regex gate runs without it, but the commit is not considered scanned until gitleaks has run.

## Things that have gone wrong before

Read these before you repeat them.

- A comment said "OMP is authoritative" while the code below it did the opposite. **Read the code, not the comment.**
- A tie-break compared generation digits across families and silently flipped three free classes to a different model. **Run the full-ladder differential.**
- A session's turn was replayed by the harness; the second run found the first run's files and reported an external intruder. **Before blaming a foreign writer, check whether the writer was an earlier run of your own session** (Hermes: `state.db` → `messages` for the same `session_id`).
- A `:free` selector was matched by substring and a strong free model got sorted into a paid class. **Classify by economics, then decorate.**

## What you may do without asking

- Add tests. Add fixtures (sanitised). Improve docs. Fix a bug with a proven root cause and a red-then-green test that respects every invariant above.

## What you must ask about

- Changing a class ladder in `policy.yml`. Changing `selectForTier` semantics. Adding a telemetry source. Anything that alters which model a *human's* session runs on.
