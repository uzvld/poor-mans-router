import type { IntelMap } from './openrouter-intel.ts';
import { canonicalBenchModel } from './bench-identity.ts';
import type { BenchObservation, BenchRow, BenchSnapshot, Facet } from './bench-types.ts';

const AA_FIELDS: Array<[keyof IntelMap[string], Facet, string]> = [
  ['coding', 'coding', 'AA coding index'],
  ['agentic', 'agentic', 'AA agentic index'],
  ['intelligence', 'general', 'AA intelligence index'],
];

/** Release date of a snapshot key (`…-20260928`), `''` for an undated one: undated sorts first. */
const releasedOn = (slug: string): string => slug.match(/-(\d{8})$/)?.[1] ?? '';

/**
 * The OpenRouter/Artificial Analysis cache the router already keeps, as a `BenchSnapshot`. AA exposes
 * no index version, so `sourceVersion` is constant: a re-baseline is found by comparing snapshots
 * (`detectRebaseline`), never by a version string. Two release spellings of one model collapse to one
 * row and the newer release wins per facet.
 */
export function aaSnapshot(intel: IntelMap, fetchedAt: number): BenchSnapshot {
  const byModel = new Map<string, Map<Facet, BenchObservation>>();
  const slugs = Object.keys(intel).sort((a, b) => releasedOn(a).localeCompare(releasedOn(b)) || a.localeCompare(b));

  for (const slug of slugs) {
    const identity = canonicalBenchModel(slug);
    if (!identity) continue;
    const entry = intel[slug];
    for (const [field, facet, label] of AA_FIELDS) {
      const value = entry?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const facets = byModel.get(identity.model) ?? new Map<Facet, BenchObservation>();
      facets.set(facet, { facet, value, confidence: 1, label });
      byModel.set(identity.model, facets);
    }
  }

  const rows: BenchRow[] = [...byModel].map(([model, facets]) => ({ model, observations: [...facets.values()] }));
  return { source: 'aa', fetchedAt, sourceVersion: 'aa', rows };
}
