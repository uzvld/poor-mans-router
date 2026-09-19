import type { ExecLike } from './telemetry.ts';

export interface RouteHistory {
  reliability: number;
  errorRate: number;
  requests: number;
  ttftMs?: number;
  throughput?: number;
}

export type HistoryMap = Record<string, RouteHistory>;

export function parseOmpStatsText(text: string): any {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('OMP stats output did not contain JSON');
  return JSON.parse(text.slice(start));
}

export function normalizeHistory(stats: any): HistoryMap {
  const out: HistoryMap = {};
  for (const row of stats?.byModel ?? []) {
    const provider = String(row?.provider ?? '');
    const model = String(row?.model ?? '');
    if (!provider || !model) continue;
    const errorRate = typeof row?.errorRate === 'number' ? Math.max(0, Math.min(1, row.errorRate)) : 0.5;
    out[`${provider}/${model}`] = {
      reliability: 1 - errorRate,
      errorRate,
      requests: typeof row?.totalRequests === 'number' ? row.totalRequests : 0,
      ttftMs: typeof row?.avgTtft === 'number' ? row.avgTtft : undefined,
      throughput: typeof row?.avgTokensPerSecond === 'number' ? row.avgTokensPerSecond : undefined,
    };
  }
  return out;
}

export async function fetchOmpHistory(exec: ExecLike): Promise<HistoryMap> {
  const result = await exec.exec('omp', ['stats', '--json'], { timeout: 180_000 });
  if (result.code !== 0) return {};
  try {
    return normalizeHistory(parseOmpStatsText(result.stdout));
  } catch {
    return {};
  }
}
