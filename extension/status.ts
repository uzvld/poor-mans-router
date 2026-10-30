import type { BlendContribution } from './bench-blend.ts';
import { ATTRIBUTION, type BenchSource, type Facet } from './bench-types.ts';
import type { NormalizedRoute, Tier } from './types.ts';

export interface StatusSources {
  ompUsageAgeMs?: number;
  codexBarAgeMs?: number;
  openRouterIntelAgeMs?: number;
  /** Set while a Data API 429 blocks refreshes (epoch ms): why the ladder may be `static`. */
  openRouterIntelBlockedUntil?: number;
  historyAgeMs?: number;
  /** One entry per benchmark source that has a snapshot (or is expected to). */
  bench?: BenchStatus[];
}

export interface BenchStatus {
  source: BenchSource;
  ageMs: number;
  /** The date the source states for its own data. */
  publishedAt?: string;
  models: number;
  /** Its newest snapshot is on a different scale than the one before it. */
  rebaselined: boolean;
  /** No snapshot for three days: the router is running on old evidence. */
  stale: boolean;
}

/** What each source said about the selected model, by facet, and what a nerf took off it. */
export interface StatusContributions {
  model: string;
  facets: Partial<Record<Facet, BlendContribution[]>>;
  penalty?: number;
}

export interface LadderStatus {
  source: 'snapshot' | 'static';
  order: string[];
}

export interface RouteStatusInput {
  tier: Tier;
  /** Routing mode; omitted by callers that only render a decision. */
  mode?: string;
  /** Class order the tier was actually walked in, and where it came from. */
  ladder?: LadderStatus;
  selected?: string;
  reason?: string;
  routes: Pick<NormalizedRoute, 'key' | 'health'>[];
  sources: StatusSources;
  contributions?: StatusContributions;
}

function age(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

const SOURCE_LABEL: Record<BenchSource, string> = { aa: 'Artificial Analysis', epoch: 'Epoch AI', lmarena: 'LMArena', benchlm: 'BenchLM' };

/** Source scores come on their own scales (an Elo of 1500, a pass rate of 0.6): keep three significant digits. */
const score = (value: number): string => value.toFixed(Math.abs(value) >= 10 ? 1 : 3);

/** The benchmark section: each source's age and condition, what they said about the chosen model, and the credits the licences ask for. */
function benchLines(bench: BenchStatus[], contributions?: StatusContributions): string[] {
  const lines = ['', 'benchmarks:'];
  for (const entry of bench) {
    const facts = [
      `${age(entry.ageMs)} old`,
      ...(entry.publishedAt ? [`data ${entry.publishedAt}`] : []),
      `${entry.models} models`,
      ...(entry.rebaselined ? ['re-based'] : []),
      ...(entry.stale ? ['stale'] : []),
    ];
    lines.push(`  ${SOURCE_LABEL[entry.source]}: ${facts.join(' · ')}`);
  }
  if (contributions) {
    lines.push(`  ${contributions.model}:`);
    for (const [facet, parts] of Object.entries(contributions.facets)) {
      const weight = parts.reduce((sum, part) => sum + part.confidence, 0);
      if (weight <= 0) continue;
      const mean = parts.reduce((sum, part) => sum + part.confidence * part.mapped, 0) / weight;
      const said = parts.map((part) => `${part.source} ${part.label} ${score(part.value)}→${part.mapped.toFixed(3)} (×${part.confidence})`);
      lines.push(`    ${facet} ${mean.toFixed(3)} = ${said.join(', ')}`);
    }
    if (contributions.penalty) lines.push(`    nerf penalty ${contributions.penalty.toFixed(3)} taken off every facet`);
  }
  lines.push('  credits:');
  for (const entry of bench) lines.push(`    ${ATTRIBUTION[entry.source]}`);
  return lines;
}

export function formatRouteStatus(input: RouteStatusInput): string {
  const lines = [
    ...(input.mode !== undefined ? [`mode: ${input.mode}`] : []),
    `tier: ${input.tier}`,
    ...(input.ladder
      ? [`ladder: ${input.ladder.source === 'snapshot' ? 'computed from snapshot' : 'shipped policy'} — ${input.ladder.order.join(' > ')}`]
      : []),
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
  const blocked = input.sources.openRouterIntelBlockedUntil;
  const block = blocked === undefined ? '' : ` · rate-limited until ${new Date(blocked).toISOString()}`;
  lines.push(`  OpenRouter Data API: ${age(input.sources.openRouterIntelAgeMs)} old${block}`);
  if (input.sources.historyAgeMs !== undefined) lines.push(`  OMP stats: ${age(input.sources.historyAgeMs)} old`);
  if (input.sources.bench && input.sources.bench.length > 0) lines.push(...benchLines(input.sources.bench, input.contributions));
  return lines.join('\n');
}
