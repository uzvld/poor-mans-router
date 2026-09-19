# Finding: does any Multica runtime launch `omp` with `--no-extensions`?

Date: 2026-09-19
Scope: read-only static/log inspection of the installed Multica desktop app on this machine. No process was started, stopped, or restarted. No code was executed beyond `strings`, `grep`, `nm`, `zgrep`/`gzcat`, `python3` byte-offset dumps, and `defaults read`.

## Verdict

**No.** Across every real Multica-launched `omp` invocation captured in the logs on this machine (649 invocations total, both the frozen legacy log and the live rotating profile logs), the argv passed to `omp` is always one of two fixed shapes and never contains `--no-extensions`. Static inspection of the Multica daemon binary's symbol table shows there is no `omp`-specific argument-builder function (no `buildOmpArgs`, no `ompBackend`) analogous to the ones that exist for other providers, and the `--no-extensions` string constant sits in the binary's string pool immediately adjacent to Claude-CLI-specific flags and Claude model names, not in the string cluster associated with `omp`'s own flags/env var. This is strong but still static (non-disassembled) evidence that `--no-extensions` belongs to the `claude` provider's flag vocabulary, structurally separate from the `omp` launch path.

I could not fully disassemble the binary to mathematically prove `--no-extensions` is unreachable for `provider=omp` under every possible runtime code path (see "What I could not determine" below). The claim above is bounded to: real observed behavior (definitive) plus static string/symbol structure (strong circumstantial, not proof of unreachability).

## 1. Every distinct `omp` argv observed in the logs

Command used to enumerate `provider=omp` launches per log file:

```
grep -n "agent command component=daemon provider=omp" <file>
grep "agent command component=daemon provider=omp" <file> | grep -oE 'args="\[[^]]*\]"' | sort | uniq -c
```

For the gzip-rotated files (macOS `zcat` doesn't handle `.gz` without a `.Z` suffix, so `gzcat` was used):

```
for f in daemon-*.log.gz; do gzcat "$f" | grep "agent command component=daemon provider=omp" | grep -oE 'args="\[[^]]*\]"' | sort | uniq -c; done
```

| argv (values redacted by Multica itself in the log) | Occurrences | Source log |
|---|---|---|
| `[-p --mode <redacted> --session <redacted>]` (5 args) | 75 | `~/.multica/daemon.log` (legacy, frozen, last write 2026-09-16 12:58, daemon version 0.4.44) |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 86 | `~/.multica/daemon.log` (same legacy file) |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 14 | `~/.multica/profiles/desktop-api.multica.ai/daemon-2026-09-17T09-33-54.352.log.gz` |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 180 | `.../daemon-2026-09-17T19-26-40.725.log.gz` |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 160 | `.../daemon-2026-09-18T05-45-07.971.log.gz` |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 93 | `.../daemon-2026-09-18T21-47-52.904.log.gz` |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 34 | `.../daemon-2026-09-19T10-16-34.898.log.gz` |
| `[-p --mode <redacted> --session <redacted> --model <redacted>]` (7 args) | 5 (still growing; live daemon) | `.../desktop-api.multica.ai/daemon.log` (current, as of read time 13:03) |

Totals: 161 launches in the legacy top-level log (75 five-arg + 86 seven-arg), 486 launches in the current profile's rotated+live logs (all seven-arg) = **647 real `omp` launches observed, 2 distinct argv shapes, `--no-extensions` in 0 of them.**

Every one of these launches was also checked for hidden/injected flags via the paired `invoking backend` log line, which reports how many extra flags the task configuration contributed:

```
grep "invoking backend component=daemon.*provider=omp" ~/.multica/daemon.log | grep -oE 'custom_args=[0-9]+ extra_args=[0-9]+' | sort | uniq -c
# => 162 custom_args=0 extra_args=0
grep "invoking backend component=daemon.*provider=omp" .../desktop-api.multica.ai/daemon.log <rotated files via gzcat> | grep -oE 'custom_args=[0-9]+ extra_args=[0-9]+' | sort | uniq -c
# => 487 custom_args=0 extra_args=0
```

Every observed `omp` task had `custom_args=0 extra_args=0` — no per-task flag injection occurred in any captured launch, so there is no case where a task-level override could have smuggled `--no-extensions` in either.

Two log files were confirmed to be genuinely distinct (not the same file read twice): `~/.multica/daemon.log` (inode 222150816, static since Sep 16) vs. `~/.multica/profiles/desktop-api.multica.ai/daemon.log` (inode 266214757, live/growing), verified with `ls -li` on both paths.

The top-level `~/.multica/daemon.log` predates the per-profile log layout (its own first line reads `agents="[claude codex hermes omp]"`, daemon `version=0.4.44`); the currently installed daemon is `version=0.5.0` per `defaults read /Applications/Multica.app/Contents/Info.plist CFBundleShortVersionString`. Both versions' real launches show the same two argv shapes and neither ever includes `--no-extensions`.

## 2. What was found in the compiled daemon binary

Binary: `/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica` (Mach-O 64-bit arm64 Go binary, unstripped symbol table, `file` output confirmed with `file "$BIN"`).

### 2a. The flag string exists

```
strings -n 5 "$BIN" | grep -n -- "--no-extensions"
```
Output (line 176 of the `strings` dump, byte offset located separately):
```
...--output-formatomp (json mode)--system-prompt--print-timeout--no-alt-screen--exclude-tools--no-extensions--approval-modeclaude-opus-4-8claude-opus-4-7claude-opus-4-6...
```

```
grep -aob -- "--no-extensions" "$BIN"
# => 7728123:--no-extensions
```

Go compiles string literals into one contiguous run of bytes in `.rodata` with no delimiters between them (the runtime looks them up by separate `(pointer,length)` descriptors), so `strings`/`grep` cannot split this run into its individual source-level literals with certainty. Read literally as printable text, the run around the flag is:

`--output-format` `omp (json mode)` `--system-prompt` `--print` `-timeout` `--no-alt-screen` `--exclude-tools` `--no-extensions` `--approval-mode` `claude-opus-4-8` `claude-opus-4-7` `claude-opus-4-6` ...

immediately followed further down the same contiguous run (same `strings` line) by `claude finished`, `mcp-config.json`, `claude-sonnet-5`, `Claude Sonnet 5`, `Claude Opus 4.8/4.7/4.6`. This run sits between unrelated Go-runtime strings, so it is a discrete source-code string-literal region — but it is the **Claude-model/Claude-flag** region, not the region containing `omp`'s own launch flags (see 2b).

### 2b. A second, separate flag string exists near `omp`'s actual env var/path, and it does NOT contain `--no-extensions`

```
grep -aob -- "MULTICA_OMP" "$BIN"   # => 7708462:MULTICA_OMP
```
Raw bytes at that offset (`python3` seek+read, `.decode('latin1')`), byte offset ~19,661 bytes before the `--no-extensions` occurrence and in a distinct string-literal run:
```
...stream-jsonMULTICA_OMP.omp/skills--workspace--allow-all--extension--no-skills--no-themes--safe-modeinputTokens...
```
i.e. the flags textually adjacent to the `MULTICA_OMP` env-var literal and the `.omp/skills` path literal are `--workspace`, `--allow-all`, `--extension` (singular — not `--no-extensions`), `--no-skills`, `--no-themes`, `--safe-mode`. `--no-extensions` does not appear in this run.

### 2c. Symbol-table evidence: no dedicated `omp` argument builder exists

The binary retains full Go symbol names (`nm "$BIN"`, 23,471 symbols, not stripped). Every other agent provider has its own per-provider backend type and (for most) a dedicated `build*Args` function, e.g.:

```
github.com/multica-ai/multica/server/pkg/agent.(*claudeBackend).Execute
github.com/multica-ai/multica/server/pkg/agent.buildClaudeArgs
github.com/multica-ai/multica/server/pkg/agent.(*codexBackend).Execute
github.com/multica-ai/multica/server/pkg/agent.buildCodexArgs
github.com/multica-ai/multica/server/pkg/agent.(*piBackend).Execute
github.com/multica-ai/multica/server/pkg/agent.buildPiArgs
... (same pattern for antigravity, codearts, codebuddy, copilot, cursor, deveco, dim, dsh, grok, hermes, kimi, kiro, mcode, openclaw, opencode, qoder, qwen, qwenpaw, reasonix, traecli, zeroclaw)
```

Exhaustive search confirms **no** `ompBackend` type and **no** `buildOmpArgs` function exist anywhere in the binary:

```
nm "$BIN" | grep -i "ompbackend"        # no output
nm "$BIN" | grep -iE "ompargs|buildomp" # no output
nm "$BIN" | grep -oE 'github\.com/multica-ai/multica/server/pkg/agent\.\(\*[a-zA-Z]+Backend\)' | sort -u
# lists 23 backends: antigravity, claude, codearts, codebuddy, codex, copilot, cursor,
# deveco, dim, dsh, grok, hermes, kimi, kiro, mcode, openclaw, opencode, pi, qoder,
# qwen, qwenpaw, reasonix, traecli — omp is absent from this list.
```

The only `omp`-named symbols in the whole binary (searched with `nm "$BIN" | grep -ioE '[a-zA-Z0-9_./*()-]*omp[a-zA-Z0-9_./*()-]*'`, filtered for the many false positives from `compare`/`compact`/`complete`/`compress`/`component`/`compile`/`comparable`/`compat`) are:

```
github.com/multica-ai/multica/server/pkg/agent.discoverOmpModels
github.com/multica-ai/multica/server/pkg/agent.ompThinkingFromCatalogEntry
github.com/multica-ai/multica/server/pkg/agent.parseOmpEfforts
github.com/multica-ai/multica/server/pkg/agent.parseOmpModels
github.com/multica-ai/multica/server/internal/daemon/execenv.prepareOmpMcpConfig
```

All five are model-catalog/thinking-level parsing and MCP-config-prep helpers, not argv/flag construction. This is consistent with the observed logs: `omp` launches always carry the same minimal, fixed flag set (`-p --mode --session [--model]`), unlike Claude's launches which (per the string pool in 2a) draw from a much larger flag vocabulary including `--no-extensions`.

### 2c. Electron bundle (`app.asar`) — flag string absent; `omp` present only as a UI provider slug

```
grep -aoc -- "no-extensions" /Applications/Multica.app/Contents/Resources/app.asar   # => 0
grep -aoc -- "\-\-extension\b" /Applications/Multica.app/Contents/Resources/app.asar # => 0
grep -aocE '\bomp\b' /Applications/Multica.app/Contents/Resources/app.asar           # => 26
```
All 26 raw-byte `omp` hits were dumped with 60-byte context windows (`python3`, per-offset seek+read). Every one is renderer/UI source (including bundled test files) referencing `omp` purely as a provider slug/display label, e.g.:
```
qwenpaw: "QwenPaw", mcode: "MiniMax Code", omp: "Oh-My-Pi", zeroclaw: "ZeroClaw"
["Oh My Pi", "omp"]
case "omp": return <PiLogo className={className} />;
```
None reference CLI flags. The Electron bundle does not build the `omp` process invocation at all — that happens entirely in the Go daemon binary (`bin/multica`), confirmed by the log lines' `component=daemon` tag and the `pkg/agent`/`internal/daemon` symbol paths above.

### 2d. Config files — no override mechanism found

```
cat ~/.multica/config.json
cat ~/.multica/profiles/desktop-api.multica.ai/config.json
grep -oE '"[a-zA-Z_]*[Ee]xtension[a-zA-Z_]*"' both files   # no match
grep -oE '"[a-zA-Z_]*[Aa]rg[a-zA-Z_]*"|"[a-zA-Z_]*[Ff]lag[a-zA-Z_]*"' both files  # no match
```
`~/.multica/config.json` contains one `profile_command_overrides` entry, keyed by a profile id, pointing `command` at `/Users/uzvld/.local/bin/paseo-multica`. The daemon logs show this override is exercised only for `provider=pi` (`runtime_id=68b9371e-...`), a separate runtime/provider from `provider=omp` (`runtime_id=002c0475-...`). It is not applicable to `omp` launches and was out of scope for direct inspection (it is not part of the Multica app itself). No key resembling an extension/flag/arg override was found in either config file. (Auth tokens present in both files were read but are deliberately **not** quoted in this report — this repo is public and under the secret-scan gate.)

## 3. What could not be determined

- **Full reachability proof.** I did not disassemble the compiled machine code, so I cannot mathematically rule out some other, unnamed code path (e.g. a generic `Command` builder shared across providers, `github.com/multica-ai/multica/server/pkg/agent.Command.Argv`/`.exec`/`.execVia`) conditionally appending `--no-extensions` for `provider=omp` under a configuration state never exercised on this machine (e.g. a currently-unused "safe mode"/sandbox toggle, an environment variable, or a server-pushed task flag). The string-pool and symbol-table evidence in §2 makes this implausible (the flag lives in the Claude-flag string cluster, and there is no `omp`-specific arg builder to attach it to) but does not prove impossibility.
- **Server-side task configuration space.** All evidence about `custom_args`/`extra_args` is what this daemon actually received from `api.multica.ai` for tasks run on this machine. I have no visibility into whether the multica.ai backend could ever send a task/profile that injects `--no-extensions` into `extra_args` for an `omp` task — only that it never has, on this machine, in the log history available (Sep 15–19, 2026).
- **Other machines/installations.** This investigation covers only this workstation's installed Multica app (`0.5.0`) and this user's `~/.multica` state. Other Multica installs, other daemon versions, or other users' task/profile configurations were not inspected.
- **Log retention gap.** No `daemon.err.log` content exists (0 bytes in both the legacy and profile directories) and no logs older than 2026-09-15 18:45 (legacy) were found, so launches before that time, if any, are unverifiable.
