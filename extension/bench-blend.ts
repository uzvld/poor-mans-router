import { intelAliases, type IntelMap } from './openrouter-intel.ts';
import { aaSnapshot } from './bench-aa.ts';
import { detectRebaseline } from './bench-rebaseline.ts';
import type { BenchHistory } from './bench-store.ts';
import { BENCH_SOURCES, type BenchObservation, type BenchSnapshot, type BenchSource, type Facet } from './bench-types.ts';

// The blend turns the stored snapshots of every source into the plain `IntelMap` the ranking code
// already reads (`coding`, `agentic`, `intelligence`), so ranking and ladders are not aware of where a
// number came from. Every source is first put on the Artificial Analysis scale of the same facet, one
// benchmark at a time, then a model's facet is the confidence-weighted mean of what measured it.

/** Largest quality a degrading model loses: below `RUNG_HYSTERESIS` (0.02), so a noisy day never moves a rung. */
const NERF_CAP = 0.015;
/** Snapshots before the newest that the trend is measured against. */
const NERF_WINDOW = 7;
/** The newest snapshot plus two earlier ones: the least that says anything about a trend. */
const NERF_MIN_SNAPSHOTS = 3;
/** Models both a source and AA measured, at least, for a fitted line; fewer are stretched over the reference range. */
const MIN_OVERLAP = 5;

const FACETS: readonly Facet[] = ['coding', 'agentic', 'general'];
const FIELD: Record<Facet, 'coding' | 'agentic' | 'intelligence'> = { coding: 'coding', agentic: 'agentic', general: 'intelligence' };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// --- mapping onto the reference scale --------------------------------------------------------------

/** The least-squares line through points, or undefined when there are too few or no rising trend to speak of. */
function fitLine(points: Array<{ x: number; y: number }>): ((x: number) => number) | undefined {
  if (points.length < MIN_OVERLAP) return undefined;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  if (sxx <= 0 || sxy <= 0) return undefined;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  return (x) => clamp01(slope * x + intercept);
}

/**
 * A function taking a source's score to the reference scale. With enough models in common it is the
 * least-squares line through them; otherwise (or when the fit would turn the order upside down) the
 * source's range is stretched over the reference's. The result stays within 0..1.
 */
export function mapToReference(points: Array<{ model: string; x: number }>, reference: Map<string, number>): (x: number) => number {
  const fitted = fitLine(points.flatMap((p) => (reference.has(p.model) ? [{ x: p.x, y: reference.get(p.model) as number }] : [])));
  if (fitted) return fitted;

  const xs = points.map((p) => p.x);
  const low = Math.min(...xs);
  const high = Math.max(...xs);
  const ys = [...reference.values()];
  const from = ys.length > 0 ? Math.min(...ys) : 0;
  const to = ys.length > 0 ? Math.max(...ys) : 1;
  return (x) => (high > low ? clamp01(from + ((x - low) / (high - low)) * (to - from)) : (from + to) / 2);
}

// --- reasoning effort ------------------------------------------------------------------------------

/** Efforts in the order the owner's usual level makes them preferable; the first level that has a row wins. */
const EFFORT_PREFERENCE: ReadonlyArray<readonly string[]> = [['high', 'xhigh'], ['max'], ['medium'], ['low']];

/**
 * The rows of one (model, benchmark) that describe the model at the owner's usual effort: the better of
 * `high` and `xhigh`, else `max`, else `medium`, else `low`. Rows that state no effort are left alone.
 */
export function pickEffortRows(observations: BenchObservation[]): BenchObservation[] {
  const stated = observations.filter((o) => o.effort);
  if (stated.length === 0) return observations;
  for (const levels of EFFORT_PREFERENCE) {
    const rows = stated.filter((o) => o.effort && levels.includes(o.effort));
    if (rows.length > 0) return [rows.reduce((best, row) => (row.value > best.value ? row : best))];
  }
  return [];
}

// --- grouping --------------------------------------------------------------------------------------

interface Reading {
  value: number;
  confidence: number;
  ci?: number;
}

/** One benchmark (`facet|label`) of one snapshot: the effort-picked reading of every model it measured. */
function readGroups(snapshot: BenchSnapshot): Map<string, { facet: Facet; label: string; readings: Map<string, Reading> }> {
  const groups = new Map<string, { facet: Facet; label: string; readings: Map<string, Reading> }>();
  for (const row of snapshot.rows) {
    const perGroup = new Map<string, BenchObservation[]>();
    for (const observation of row.observations) {
      const key = `${observation.facet}|${observation.label}`;
      perGroup.set(key, [...(perGroup.get(key) ?? []), observation]);
    }
    for (const [key, observations] of perGroup) {
      const best = pickEffortRows(observations).reduce<BenchObservation | undefined>((top, o) => (!top || o.value > top.value ? o : top), undefined);
      if (!best) continue;
      const group = groups.get(key) ?? { facet: best.facet, label: best.label, readings: new Map<string, Reading>() };
      group.readings.set(row.model, { value: best.value, confidence: best.confidence, ...(best.ci !== undefined ? { ci: best.ci } : {}) });
      groups.set(key, group);
    }
  }
  return groups;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

// --- nerf ------------------------------------------------------------------------------------------

/**
 * Models whose LMArena rating fell after release, with the quality they lose (0..`NERF_CAP`). The
 * trend is the newest rating against the median of up to seven earlier snapshots, minus the field's
 * own drift (a recalibration moves everyone and is not a nerf), and counts only beyond the row's own
 * interval. Nothing is read from a source that was re-based: its whole scale moved.
 */
export function nerfPenalties(history: BenchHistory): Map<string, number> {
  const penalties = new Map<string, number>();
  const snapshots = history.lmarena ?? [];
  const latest = snapshots.at(-1);
  if (!latest || snapshots.length < NERF_MIN_SNAPSHOTS) return penalties;
  if (detectRebaseline(snapshots.at(-2), latest).rebaselined) return penalties;

  const earlier = snapshots.slice(-1 - NERF_WINDOW, -1).map(readGroups);
  for (const [key, group] of readGroups(latest)) {
    const deltas = new Map<string, number>();
    for (const [model, now] of group.readings) {
      const before = earlier.flatMap((groups) => groups.get(key)?.readings.get(model)?.value ?? []);
      if (before.length >= NERF_MIN_SNAPSHOTS - 1) deltas.set(model, now.value - median(before));
    }
    if (deltas.size === 0) continue;

    const drift = median([...deltas.values()]);
    const values = [...group.readings.values()].map((r) => r.value);
    const range = Math.max(...values) - Math.min(...values);
    if (range <= 0) continue;

    for (const [model, delta] of deltas) {
      const relative = delta - drift;
      const interval = group.readings.get(model)?.ci ?? 0;
      if (relative >= -interval || relative >= 0) continue;
      const penalty = Math.min(NERF_CAP, -relative / range);
      if (penalty > (penalties.get(model) ?? 0)) penalties.set(model, penalty);
    }
  }
  return penalties;
}

// --- the blend -------------------------------------------------------------------------------------

export interface BlendContribution {
  source: BenchSource;
  label: string;
  /** As the source states it. */
  value: number;
  /** On the AA scale of the facet. */
  mapped: number;
  confidence: number;
}

export interface BlendReport {
  /** Sources whose newest snapshot is on a different scale than the one before it. */
  rebaselined: BenchSource[];
  /** Models in each source's newest snapshot. */
  matched: Record<BenchSource, number>;
  /** Every contribution to every facet of a model, by canonical model key. */
  byModel: Record<string, Partial<Record<Facet, BlendContribution[]>>>;
  penalties: Record<string, number>;
}

const releasedOn = (key: string): string => key.match(/-(\d{8})$/)?.[1] ?? '';

/**
 * Blend the stored snapshots into `base` (the AA cache). AA keeps its own keys and fields it alone
 * carries; a model a source measured that AA did not is added under its canonical key. A source that
 * did not measure a model adds nothing to it (I7).
 */
export function blendIntel(base: IntelMap, history: BenchHistory): { intel: IntelMap; report: BlendReport } {
  const aa = aaSnapshot(base, 0);
  const reference = new Map<Facet, Map<string, number>>();
  const contributions = new Map<string, Map<Facet, BlendContribution[]>>();
  const add = (model: string, facet: Facet, contribution: BlendContribution): void => {
    const facets = contributions.get(model) ?? new Map<Facet, BlendContribution[]>();
    facets.set(facet, [...(facets.get(facet) ?? []), contribution]);
    contributions.set(model, facets);
  };

  for (const group of readGroups(aa).values()) {
    const scores = reference.get(group.facet) ?? new Map<string, number>();
    for (const [model, reading] of group.readings) {
      scores.set(model, reading.value);
      add(model, group.facet, { source: 'aa', label: group.label, value: reading.value, mapped: reading.value, confidence: reading.confidence });
    }
    reference.set(group.facet, scores);
  }

  const external = new Set<string>();
  const report: BlendReport = { rebaselined: [], matched: { aa: aa.rows.length, epoch: 0, lmarena: 0, benchlm: 0 }, byModel: {}, penalties: {} };
  for (const source of BENCH_SOURCES) {
    const snapshots = history[source] ?? [];
    const latest = snapshots.at(-1);
    if (latest && detectRebaseline(snapshots.at(-2), latest).rebaselined) report.rebaselined.push(source);
    if (source === 'aa' || !latest) continue;
    report.matched[source] = latest.rows.length;

    for (const group of readGroups(latest).values()) {
      const points = [...group.readings].map(([model, reading]) => ({ model, x: reading.value }));
      const map = mapToReference(points, reference.get(group.facet) ?? new Map<string, number>());
      for (const [model, reading] of group.readings) {
        add(model, group.facet, { source, label: group.label, value: reading.value, mapped: map(reading.value), confidence: reading.confidence });
        external.add(model);
      }
    }
  }

  const penalties = nerfPenalties(history);
  const aliasToKey = new Map<string, string>();
  for (const key of Object.keys(base).sort((a, b) => releasedOn(a).localeCompare(releasedOn(b)) || a.localeCompare(b))) {
    for (const alias of intelAliases(key)) aliasToKey.set(alias, key);
  }

  const intel: IntelMap = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, { ...value }]));
  for (const model of external) {
    const facets = contributions.get(model);
    if (!facets) continue;
    const penalty = penalties.get(model) ?? 0;
    const key = intelAliases(model).map((alias) => aliasToKey.get(alias)).find((k) => k !== undefined) ?? model;
    const entry = { ...(intel[key] ?? {}) };
    for (const facet of FACETS) {
      const parts = facets.get(facet);
      if (!parts) continue;
      const weight = parts.reduce((sum, p) => sum + p.confidence, 0);
      if (weight <= 0) continue;
      entry[FIELD[facet]] = Math.max(0, parts.reduce((sum, p) => sum + p.confidence * p.mapped, 0) / weight - penalty);
    }
    intel[key] = entry;
    report.byModel[model] = Object.fromEntries(FACETS.flatMap((f) => (facets.has(f) ? [[f, facets.get(f)]] : [])));
    if (penalty > 0) report.penalties[model] = penalty;
  }

  // `general` on the coding scale. The intelligence index runs far below coding and agentic (0.2-0.5 against
  // 0.4-0.8), so it cannot be averaged in as it is: a model rated on it would lose to one that was not, and
  // every measured model would lose to an unmeasured one's neutral prior. The line that relates the two
  // indices, drawn through the models that have both, puts it on the scale the other facets use. Without
  // five such models there is no line and no general is made up. The nerf penalty comes off as everywhere.
  const coded = Object.values(intel).flatMap((entry) => (entry.coding !== undefined && entry.intelligence !== undefined ? [{ x: entry.intelligence, y: entry.coding }] : []));
  const toCodingScale = fitLine(coded);
  if (toCodingScale) {
    const penaltyOf = new Map<string, number>();
    for (const [model, penalty] of penalties) {
      const key = intelAliases(model).map((alias) => aliasToKey.get(alias)).find((k) => k !== undefined) ?? model;
      penaltyOf.set(key, penalty);
    }
    for (const [key, entry] of Object.entries(intel)) {
      if (entry.intelligence !== undefined) entry.general = Math.max(0, toCodingScale(entry.intelligence) - (penaltyOf.get(key) ?? 0));
    }
  }
  return { intel, report };
}
