import type { NormalizedRoute, Tier } from './types.ts';

export interface StatusSources {
  ompUsageAgeMs?: number;
  codexBarAgeMs?: number;
  openRouterIntelAgeMs?: number;
  historyAgeMs?: number;
}

export interface RouteStatusInput {
  tier: Tier;
  /** Routing mode; omitted by callers that only render a decision. */
  mode?: string;
  selected?: string;
  reason?: string;
  routes: Pick<NormalizedRoute, 'key' | 'health'>[];
  sources: StatusSources;
}

function age(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

export function formatRouteStatus(input: RouteStatusInput): string {
  const lines = [
    ...(input.mode !== undefined ? [`mode: ${input.mode}`] : []),
    `tier: ${input.tier}`,
    `selected: ${input.selected ?? '(none)'}`,
    `reason: ${input.reason ?? '(none)'}`,
    '',
    'health:',
  ];

  for (const route of input.routes.slice(0, 16)) {
    const detail = route.health.reason ? `  ${route.health.reason}` : '';
    const until = route.health.cooldownUntil ? ` until ${new Date(route.health.cooldownUntil).toISOString()}` : '';
    lines.push(`  ${route.key}  ${route.health.state}/${route.health.freshness}${until}${detail}`);
  }

  lines.push('', 'sources:');
  lines.push(`  OMP usage: ${age(input.sources.ompUsageAgeMs)} old`);
  lines.push(`  CodexBar: ${age(input.sources.codexBarAgeMs)} old`);
  lines.push(`  OpenRouter Data API: ${age(input.sources.openRouterIntelAgeMs)} old`);
  if (input.sources.historyAgeMs !== undefined) lines.push(`  OMP stats: ${age(input.sources.historyAgeMs)} old`);
  return lines.join('\n');
}
