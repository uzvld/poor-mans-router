# Contributing

Short version: read [`AGENTS.md`](AGENTS.md). It applies to humans too.

## Pull request checklist

- [ ] Root cause is written down (for bugs) or the design change is written down (for behaviour changes) — in `docs/investigations/` or the PR body.
- [ ] A test was added that **failed before** the change and passes after. Say which test, and paste the red output.
- [ ] `bun run test` → all green. `bun run test:sim` → all green.
- [ ] `scripts/secret-scan.sh --all` → clean; the `attest` value is quoted in the PR body and in every commit trailer (`Secret-Scan: <attest>`).
- [ ] Differential replay run for all three tiers on a real snapshot; every changed selection explained.
- [ ] No fixture was added without `scripts/sanitize-fixtures.py`. Paste its "removed field paths" list.
- [ ] `git diff --cached --name-only` reviewed; nothing under `extension/state.json`, no raw telemetry, no `.env`.
- [ ] If `policy.yml` or `selectForTier` changed: a human approved the policy change explicitly.

## Commit messages

`<area>: <what changed> (<why>)` — e.g. `health: OMP capacity outranks CodexBar pace (BUG D)`. Reference the investigation file when one exists.
