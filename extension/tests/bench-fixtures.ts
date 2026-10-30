import { readFileSync, readdirSync } from 'node:fs';
import { parseBenchlm } from '../bench-benchlm.ts';
import { parseEpoch } from '../bench-epoch.ts';
import { parseLmarena } from '../bench-lmarena.ts';
import type { BenchHistory } from '../bench-store.ts';
import type { BenchSnapshot, BenchSource, Effort, Facet } from '../bench-types.ts';
import { normalizeOmpUsage, parseCodexBarRows } from '../telemetry.ts';
import { normalizeHistory, parseOmpStatsText } from '../history.ts';
import { buildRoutes, type BuildRoutesInputs, type OmpModelLike } from '../ranking.ts';
import type { IntelMap } from '../openrouter-intel.ts';

// The 2026-10-30 live capture (fixtures/bench-2026-10-30/README.md): post-re-baseline AA cache, the
// three keyless sources, and sanitised OMP/CodexBar telemetry for the same minute.
const DIR = new URL('../../fixtures/bench-2026-10-30/', import.meta.url);

export const fixtureText = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

export const AA_INTEL: IntelMap = fixtureJson<{ data: IntelMap }>('aa-intel.json').data;
const USAGE = fixtureJson<{ generatedAt: number }>('omp-usage.json');
export const NOW: number = USAGE.generatedAt;

/** Routes of the captured catalog, scored with the given intel and, optionally, other build inputs. */
export function routesWith(intel: IntelMap, extra: Partial<BuildRoutesInputs> = {}) {
  return buildRoutes(fixtureJson<{ models: OmpModelLike[] }>('omp-models.json').models, {
    ompReports: normalizeOmpUsage(USAGE),
    codexbar: parseCodexBarRows(fixtureJson('codexbar-usage.json')),
    localState: {},
    history: normalizeHistory(parseOmpStatsText(fixtureText('omp-stats.json'))),
    intel,
    reservePct: 10,
    now: NOW,
    ...extra,
  });
}

/** The three keyless sources of the capture, one snapshot each, as the store would hold them. */
export function liveHistory(): BenchHistory {
  const rows = (name: string) => fixtureJson<{ rows: unknown[] }>(name).rows;
  const epochDir = new URL('epoch/', DIR);
  const epoch = Object.fromEntries(
    readdirSync(epochDir).filter((n) => n.endsWith('.csv') && !n.startsWith('._')).map((n) => [n, fixtureText(`epoch/${n}`)]),
  );
  return {
    lmarena: [parseLmarena({
      text: { overall: rows('lmarena-text-overall.json'), coding: rows('lmarena-text-coding.json'), hard_prompts: rows('lmarena-text-hard_prompts.json') },
      agent: rows('lmarena-agent.json'),
    }, 1)],
    epoch: [parseEpoch(epoch, 1)],
    benchlm: [parseBenchlm(fixtureJson('benchlm-leaderboard.json'), 1)],
  };
}

interface Reading { value: number; confidence?: number; effort?: Effort; label?: string; ci?: number }

/** A hand-built snapshot: `{ model: { facet: value | reading } }`; confidence defaults to 1, the label to the facet. */
export function synthetic(
  source: BenchSource,
  rows: Record<string, Partial<Record<Facet, number | Reading>>>,
  options: { fetchedAt?: number; version?: string } = {},
): BenchSnapshot {
  return {
    source,
    fetchedAt: options.fetchedAt ?? 1,
    sourceVersion: options.version ?? 'v1',
    rows: Object.entries(rows).map(([model, facets]) => ({
      model,
      observations: Object.entries(facets).map(([facet, reading]) => {
        const r: Reading = typeof reading === 'number' ? { value: reading } : reading;
        return { facet: facet as Facet, value: r.value, confidence: r.confidence ?? 1, label: r.label ?? facet, ...(r.effort ? { effort: r.effort } : {}), ...(r.ci !== undefined ? { ci: r.ci } : {}) };
      }),
    })),
  };
}
