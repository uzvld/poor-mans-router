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

// The benchmark sources (Epoch, LMArena, BenchLM) and the OpenRouter Data API are public endpoints the
// extension fetches in the background. A suite that runs the refresh without stubbing `fetch` would send
// real traffic and make its result depend on the network, so anything but loopback is refused here. A suite
// that tests a fetcher assigns its own `globalThis.fetch`, as before.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof Request ? input.url : String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) return realFetch(input, init);
  return Promise.reject(new Error(`network is off in tests: ${url}`));
}) as typeof fetch;

process.on('exit', () => {
  for (const file of [scratch, intel, `${intel}.lock`, scratch.replace(/\.json$/, '.bench.json'), `${scratch.replace(/\.json$/, '.bench.json')}.lock`]) rmSync(file, { force: true });
});
