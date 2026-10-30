import type { BenchSnapshot, Facet } from './bench-types.ts';

// A source that re-bases its index changes what every score means. Merging the old and the new values
// of one model would mix two scales (the 2026-10-11 AA snapshot had `sonnet-5` at 0.382 on the old index
// and `sonnet-5.5` at 0.542 on the new one). Nothing in AA's payload says it happened, so it is found by
// comparing consecutive snapshots of the same source.

/** Share of the models measured on a facet that may disappear from it between two snapshots. */
const LOST_SHARE = 0.3;
/** Median score change, as a share of the facet's range, that no ordinary day reaches. */
const SHIFT_SHARE = 0.05;
/** Fewer models than this say nothing about a source. */
const MIN_MODELS = 5;

const FACETS: readonly Facet[] = ['coding', 'agentic', 'general'];

export interface RebaselineVerdict {
  rebaselined: boolean;
  reason?: string;
}

/** Best score per model on one facet: efforts of one model are not separate models here. */
function facetScores(snapshot: BenchSnapshot, facet: Facet): Map<string, number> {
  const scores = new Map<string, number>();
  for (const row of snapshot.rows) {
    for (const observation of row.observations) {
      if (observation.facet !== facet) continue;
      scores.set(row.model, Math.max(scores.get(row.model) ?? Number.NEGATIVE_INFINITY, observation.value));
    }
  }
  return scores;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Whether `next` is on a different scale than `previous`: the methodology version changed; or a
 * third of the models measured on a facet no longer carry it; or the models present in both moved
 * together by more than an ordinary day does (a uniform shift loses no model).
 */
export function detectRebaseline(previous: BenchSnapshot | undefined, next: BenchSnapshot): RebaselineVerdict {
  if (!previous) return { rebaselined: false };
  if (previous.sourceVersion !== next.sourceVersion) {
    return { rebaselined: true, reason: `methodology changed: ${previous.sourceVersion} → ${next.sourceVersion}` };
  }

  for (const facet of FACETS) {
    const before = facetScores(previous, facet);
    if (before.size < MIN_MODELS) continue;
    const after = facetScores(next, facet);

    const lost = [...before.keys()].filter((model) => !after.has(model)).length;
    if (lost / before.size >= LOST_SHARE) {
      return { rebaselined: true, reason: `${facet}: ${lost} of ${before.size} models measured before no longer carry it` };
    }

    const common = [...before.keys()].filter((model) => after.has(model));
    if (common.length < MIN_MODELS) continue;
    const old = common.map((model) => before.get(model) as number);
    const range = Math.max(...old) - Math.min(...old);
    if (range <= 0) continue;
    const shift = median(common.map((model) => Math.abs((after.get(model) as number) - (before.get(model) as number)))) / range;
    if (shift > SHIFT_SHARE) {
      return { rebaselined: true, reason: `${facet}: scores moved together by ${(shift * 100).toFixed(0)}% of their range` };
    }
  }
  return { rebaselined: false };
}
