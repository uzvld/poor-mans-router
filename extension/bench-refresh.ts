import { aaSnapshot } from './bench-aa.ts';
import { fetchBenchlm } from './bench-benchlm.ts';
import { fetchEpoch } from './bench-epoch.ts';
import { fetchLmarena } from './bench-lmarena.ts';
import { BENCH_TTL_MS, benchRefreshDue, type BenchStore } from './bench-store.ts';
import type { BenchSnapshot, BenchSource } from './bench-types.ts';
import type { IntelCache } from './openrouter-intel.ts';

// Refresh is driven by staleness, not by a clock: a source is fetched when its newest snapshot is older
// than 24 h, from the background path `refreshIntel` already runs on, never from a turn. Days the
// machine is not used leave gaps in the history, which the trend and the re-baseline check tolerate.

export type KeylessSource = Exclude<BenchSource, 'aa'>;
export type BenchFetchers = Record<KeylessSource, (now: number) => Promise<BenchSnapshot>>;

/** Fastest first: a slow LMArena must not delay the two light sources. */
const KEYLESS: readonly KeylessSource[] = ['epoch', 'benchlm', 'lmarena'];

export const LIVE_FETCHERS: BenchFetchers = {
  epoch: (now) => fetchEpoch(globalThis.fetch, now),
  benchlm: (now) => fetchBenchlm(globalThis.fetch, now),
  lmarena: (now) => fetchLmarena(globalThis.fetch, now),
};

/**
 * Fetch every keyless source that is due and store what comes back. Each source is independent: one that
 * fails (or answers with nothing) leaves the others stored and its own last good snapshot in place, and
 * is not tried again before the retry floor. A source a peer process is refreshing is left to it.
 * Returns whether any snapshot landed. Never throws.
 */
export async function refreshKeylessSources(
  store: BenchStore,
  fetchers: BenchFetchers,
  now: number,
  log: (message: string, detail: { error: string }) => void,
): Promise<boolean> {
  let landed = false;
  for (const source of KEYLESS) {
    const dueAt = Math.max(now, Date.now());
    if (!benchRefreshDue(store.read(dueAt), source, dueAt)) continue;
    const release = store.claim(Math.max(now, Date.now()));
    if (!release) continue;
    try {
      // A peer may have finished while this process waited for the claim.
      const recheckAt = Math.max(now, Date.now());
      if (!benchRefreshDue(store.read(recheckAt), source, recheckAt)) continue;
      const attemptAt = Math.max(now, Date.now());
      await store.recordAttempt(source, attemptAt);
      const fetchStartedAt = Math.max(now, Date.now());
      await store.append(await fetchers[source](fetchStartedAt), fetchStartedAt);
      landed = true;
    } catch (error) {
      log(`pmr ${source} benchmark refresh failed`, { error: String(error) });
    } finally {
      release();
    }
  }
  return landed;
}

/**
 * Keep the OpenRouter/AA cache (which refreshes every six hours) as one snapshot per day, so the history
 * can tell a re-baseline from an ordinary day. Returns whether a snapshot was stored. Never throws.
 */
export async function recordAaSnapshot(store: BenchStore, intel: IntelCache, now: number): Promise<boolean> {
  try {
    if (intel.fetchedAt <= 0) return false;
    const newest = store.read(now).history.aa?.at(-1);
    if (newest && intel.fetchedAt - newest.fetchedAt < BENCH_TTL_MS) return false;
    const snapshot = aaSnapshot(intel.data, intel.fetchedAt);
    if (snapshot.rows.length === 0) return false;
    await store.append(snapshot, now);
    return true;
  } catch {
    return false;
  }
}
