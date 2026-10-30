// Shared shapes of the multi-source benchmark layer (docs/superpowers/specs/2026-10-30-benchmark-snapshots-design.md).
// A source adapter turns one fetch into a `BenchSnapshot`; `bench-blend.ts` turns the stored history
// into the `IntelMap` the ranking code already reads.

export type Facet = 'coding' | 'agentic' | 'general';
export type BenchSource = 'aa' | 'epoch' | 'lmarena' | 'benchlm';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const BENCH_SOURCES: readonly BenchSource[] = ['aa', 'epoch', 'lmarena', 'benchlm'];

export interface BenchObservation {
  facet: Facet;
  /** The score as the source states it, on the source's own scale. Mapping to the AA scale happens at blend time. */
  value: number;
  /** 0..1: how much this observation counts against the others of the same facet. */
  confidence: number;
  /** Benchmark or category, shown by /route-status. */
  label: string;
  /** Reasoning effort of the measured row, when the source states one. */
  effort?: Effort;
  /** Half-width of the source's own uncertainty, on the same scale as `value`. */
  ci?: number;
}

export interface BenchRow {
  /** `vendor/slug`, lower case, dotted versions, no effort and no date (see `canonicalBenchModel`). */
  model: string;
  observations: BenchObservation[];
}

export interface BenchSnapshot {
  source: BenchSource;
  fetchedAt: number;
  /**
   * The source's methodology: what its scores mean. Two snapshots with a different version are on different
   * scales and are never merged. It is NOT a publication date (that changes daily and would flag every
   * snapshot as a re-baseline), and not a content hash. A source that states no methodology version uses a
   * constant, and a re-baseline is found by comparing snapshots (`detectRebaseline`).
   */
  sourceVersion: string;
  /** The date the source states for its own data (leaderboard publish date, newest release); shown, never compared. */
  publishedAt?: string;
  rows: BenchRow[];
}

export type FacetWeights = Record<Facet, number>;

/** Attribution each source's licence asks for; shown in /route-status and the README. */
export const ATTRIBUTION: Record<BenchSource, string> = {
  aa: 'Artificial Analysis, via the OpenRouter Data API',
  epoch: 'Epoch AI, "Capabilities & benchmarking" (CC BY 4.0), epoch.ai/benchmarks',
  lmarena: 'LMArena leaderboard dataset (CC BY 4.0), huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
  benchlm: 'Data from BenchLM.ai (CC BY-NC 4.0)',
};
