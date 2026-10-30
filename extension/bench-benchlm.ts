import { canonicalBenchModel } from './bench-identity.ts';
import { isFiniteNumber, isRecord } from './bench-util.ts';
import type { BenchObservation, BenchRow, BenchSnapshot, Facet } from './bench-types.ts';

// BenchLM publishes its rankings as static JSON (CC BY-NC 4.0: "Data from BenchLM.ai"; the owner
// confirms this project is non-commercial and open source). `items` is the overall board, and
// `categories.coding` / `categories.agentic` rank the same models by category. In a category list
// `displayScore` is still the model's OVERALL score: the category's own score is `score`.

const URL_LEADERBOARD = 'https://benchlm.ai/data/leaderboard.json';
const FETCH_TIMEOUT_MS = 20_000;
/** Many BenchLM scores are model-based estimates; they count for half of a supported measurement. */
const SUPPORTED_CONFIDENCE = 0.5;

const BOARDS: Array<{ facet: Facet; label: string; list: (body: Record<string, unknown>) => unknown }> = [
  { facet: 'general', label: 'BenchLM overall', list: (body) => body.items },
  { facet: 'coding', label: 'BenchLM coding', list: (body) => (isRecord(body.categories) ? body.categories.coding : undefined) },
  { facet: 'agentic', label: 'BenchLM agentic', list: (body) => (isRecord(body.categories) ? body.categories.agentic : undefined) },
];

export function parseBenchlm(body: unknown, fetchedAt: number): BenchSnapshot {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('BenchLM: not a leaderboard');
  const byModel = new Map<string, BenchObservation[]>();

  for (const { facet, label, list } of BOARDS) {
    const entries = list(body);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.canonicalModelKey !== 'string' || !isFiniteNumber(entry.score)) continue;
      const identity = canonicalBenchModel(entry.canonicalModelKey, typeof entry.creator === 'string' ? entry.creator : undefined);
      if (!identity) continue;
      const observation: BenchObservation = {
        facet,
        value: entry.score / 100,
        confidence: entry.evidenceStatus === 'estimated' ? SUPPORTED_CONFIDENCE / 2 : SUPPORTED_CONFIDENCE,
        label,
      };
      byModel.set(identity.model, [...(byModel.get(identity.model) ?? []), observation]);
    }
  }

  if (byModel.size === 0) throw new Error('BenchLM: the leaderboard held no usable row');
  const rows: BenchRow[] = [...byModel].map(([model, observations]) => ({ model, observations }));
  const published = typeof body.generatedAt === 'string' ? body.generatedAt.slice(0, 10) : '';
  return {
    source: 'benchlm',
    fetchedAt,
    // `rankingMode` names the methodology; `dataVersion` is a content hash that changes with every update.
    sourceVersion: typeof body.rankingMode === 'string' ? body.rankingMode : 'benchlm',
    ...(published ? { publishedAt: published } : {}),
    rows,
  };
}

export async function fetchBenchlm(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<BenchSnapshot> {
  const response = await fetchImpl(URL_LEADERBOARD, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`BenchLM: HTTP ${response.status}`);
  return parseBenchlm(await response.json(), now);
}
