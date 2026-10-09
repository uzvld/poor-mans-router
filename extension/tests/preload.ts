import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The router resolves its state file (and the intel file beside it) from PMR_STATE_FILE, defaulting
// to the extension directory — the developer's real `extension/state.json`. Suites that build the
// extension without choosing a scratch path would read and write that real state (AGENTS.md: tests
// never read state.json). Every test process starts on a per-process scratch path; a suite that
// needs its own sets PMR_STATE_FILE before constructing the extension, as before.
//
// Loaded through extension/bunfig.toml, so it applies only when `bun test` runs from extension/
// (which `bun run test` does).
const scratch = join(tmpdir(), `pmr-test-state-default-${process.pid}.json`);
const intel = scratch.replace(/\.json$/, '.intel.json');
process.env.PMR_STATE_FILE = scratch;

process.on('exit', () => {
  for (const file of [scratch, intel, `${intel}.lock`]) rmSync(file, { force: true });
});
