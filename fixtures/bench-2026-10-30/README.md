# Benchmark snapshot captured 2026-10-30

Public benchmark data plus sanitised telemetry (`scripts/sanitize-fixtures.py`). No credentials.

| file | source | licence / attribution |
|---|---|---|
| `aa-intel.json` | Artificial Analysis through the OpenRouter Data API (the router's own cache) | OpenRouter / Artificial Analysis terms |
| `lmarena-*.json` | `lmarena-ai/leaderboard-dataset` on Hugging Face | CC-BY 4.0, LMArena |
| `epoch/*.csv` | Epoch AI benchmark data (`epoch.ai/data/benchmark_data.zip`), columns trimmed | CC-BY 4.0, credit Epoch AI |
| `benchlm-leaderboard.json` | `benchlm.ai/data/leaderboard.json`, fields trimmed | CC BY-NC 4.0, "Data from BenchLM.ai" |
| `omp-*.json`, `codexbar-usage.json` | local telemetry, sanitised | |

## One correction to `aa-intel.json`

The AA cache this file was copied from was written by a normaliser that read an index of 1 or less as a
fraction instead of points out of 100 (fixed in `openrouter-intel.ts`, `indexScore`). Fourteen agentic scores in
the capture are impossible (four at 1.0, five at 0.9, five at 0.8; the real maximum is 57.9 points). All fourteen
are models whose raw `score` was 1, 0.9 or 0.8 in `fixtures/aa-bench-2026-09-22.json`, and were divided by 100
here. Other mis-scaled values (raw 0.6, 0.5, 0.1) look plausible as fractions and cannot be recovered from the
cache; they heal on the next refresh of a router running the fixed normaliser.
