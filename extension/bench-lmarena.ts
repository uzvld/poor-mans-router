import { canonicalBenchModel } from './bench-identity.ts';
import { delay, isFiniteNumber, isRecord } from './bench-util.ts';
import type { BenchObservation, BenchRow, BenchSnapshot, Facet } from './bench-types.ts';

// LMArena publishes its leaderboards as a Hugging Face dataset (CC BY 4.0), readable without a key:
//   config `text`  — human preference ratings per category (overall, coding, hard_prompts, …)
//   config `agent` — task outcomes of agent sessions: `score`, its interval, millions of observations
// The agent board is the closest public measurement of what this router's work is, so it counts most.

export interface LmarenaBoards {
  text: Record<'overall' | 'coding' | 'hard_prompts', unknown[]>;
  agent: unknown[];
}

const TEXT_BOARDS = [
  { board: 'overall', facet: 'general', label: 'LMArena text overall' },
  { board: 'coding', facet: 'coding', label: 'LMArena text coding' },
  { board: 'hard_prompts', facet: 'general', label: 'LMArena hard prompts' },
] as const satisfies ReadonlyArray<{ board: keyof LmarenaBoards['text']; facet: Facet; label: string }>;

/** Preference ratings measure taste, not task success: they count less than agent outcomes. */
const TEXT_CONFIDENCE = 0.4;
const AGENT_CONFIDENCE = 0.9;

interface Reading {
  facet: Facet;
  label: string;
  confidence: number;
  value: string;
  lower: string;
  upper: string;
}

/** Half-width of the published interval, when both ends are published. */
function halfWidth(lower: unknown, upper: unknown): number | undefined {
  return isFiniteNumber(lower) && isFiniteNumber(upper) && upper >= lower ? (upper - lower) / 2 : undefined;
}

export function parseLmarena(boards: LmarenaBoards, fetchedAt: number): BenchSnapshot {
  const byModel = new Map<string, BenchObservation[]>();
  let version = '';

  const read = (rows: unknown[], reading: Reading): void => {
    for (const row of rows) {
      if (!isRecord(row) || typeof row.model_name !== 'string') continue;
      const value = row[reading.value];
      if (!isFiniteNumber(value)) continue;
      const identity = canonicalBenchModel(row.model_name, typeof row.organization === 'string' ? row.organization : undefined);
      if (!identity) continue;
      const ci = halfWidth(row[reading.lower], row[reading.upper]);
      const observation: BenchObservation = {
        facet: reading.facet,
        value,
        confidence: reading.confidence,
        label: reading.label,
        ...(identity.effort ? { effort: identity.effort } : {}),
        ...(ci !== undefined ? { ci } : {}),
      };
      byModel.set(identity.model, [...(byModel.get(identity.model) ?? []), observation]);
      if (typeof row.leaderboard_publish_date === 'string' && row.leaderboard_publish_date > version) version = row.leaderboard_publish_date;
    }
  };

  read(boards.agent, { facet: 'agentic', label: 'LMArena agent', confidence: AGENT_CONFIDENCE, value: 'score', lower: 'score_ci_lower', upper: 'score_ci_upper' });
  for (const { board, facet, label } of TEXT_BOARDS) {
    read(boards.text[board], { facet, label, confidence: TEXT_CONFIDENCE, value: 'rating', lower: 'rating_lower', upper: 'rating_upper' });
  }

  if (byModel.size === 0) throw new Error('LMArena: the boards held no usable row');
  const rows: BenchRow[] = [...byModel].map(([model, observations]) => ({ model, observations }));
  // No methodology version is published: constant, so a re-baseline is found by comparing snapshots.
  return { source: 'lmarena', fetchedAt, sourceVersion: 'lmarena', ...(version ? { publishedAt: version } : {}), rows };
}

// --- fetch ---------------------------------------------------------------------------------------

const SERVER = 'https://datasets-server.huggingface.co/filter';
const PAGE_ROWS = 100;
const MAX_PAGES = 20;
/** The datasets-server answers slowly (40 s observed) and throttles a burst of requests. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * One page. A server that answers 429 or 5xx (observed: 502 twice while capturing fixtures) is asked again
 * once after a pause; a network error (offline, DNS, timeout) is not, since the next refresh comes in
 * 15 minutes anyway and waiting here only holds the background refresh up.
 */
async function page(fetchImpl: typeof fetch, config: string, category: string, offset: number, paceMs: number): Promise<{ rows: unknown[]; total: number }> {
  const where = encodeURIComponent(`"category"='${category}'`);
  const url = `${SERVER}?dataset=lmarena-ai%2Fleaderboard-dataset&config=${config}&split=latest&where=${where}&offset=${offset}&length=${PAGE_ROWS}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await delay(paceMs * 2);
        continue;
      }
      throw new Error(`LMArena ${config}/${category}: HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.rows) || !isFiniteNumber(body.num_rows_total)) throw new Error(`LMArena ${config}/${category}: unexpected body`);
    return { rows: body.rows.map((entry) => (isRecord(entry) ? entry.row : undefined)), total: body.num_rows_total };
  }
}

async function board(fetchImpl: typeof fetch, config: string, category: string, paceMs: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let index = 0; index < MAX_PAGES; index++) {
    const { rows: chunk, total } = await page(fetchImpl, config, category, rows.length, paceMs);
    rows.push(...chunk);
    if (rows.length >= total) break;
    if (chunk.length === 0) throw new Error(`LMArena ${config}/${category}: incomplete board (${rows.length} of ${total} rows)`);
    if (index === MAX_PAGES - 1) throw new Error(`LMArena ${config}/${category}: board exceeds ${MAX_PAGES} pages`);
    await delay(paceMs);
  }
  return rows;
}

/**
 * Fetch the four boards one after another (the server throttles bursts) and parse them. All or
 * nothing: a board that cannot be read fails the whole snapshot, which keeps the last good one.
 */
export async function fetchLmarena(fetchImpl: typeof fetch = fetch, now = Date.now(), paceMs = 1000): Promise<BenchSnapshot> {
  const agent = await board(fetchImpl, 'agent', 'overall', paceMs);
  const overall = await board(fetchImpl, 'text', 'overall', paceMs);
  const coding = await board(fetchImpl, 'text', 'coding', paceMs);
  const hardPrompts = await board(fetchImpl, 'text', 'hard_prompts', paceMs);
  return parseLmarena({ text: { overall, coding, hard_prompts: hardPrompts }, agent }, now);
}
