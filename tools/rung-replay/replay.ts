// Investigation tool — differential replay for the data-derived rung order (see
// docs/investigations/finding-unclassified-model-names.md § "Prototype: rungs from a snapshot").
//
// Run from anywhere with Bun:  bun run tools/rung-replay/replay.ts
//
// Both arms of every comparison use the SAME intel snapshot; the only difference is the ladder,
// so a line that differs is caused by the rung order and nothing else. The fallback chain repeats
// the choice with the winner cooled down, which is what the order actually decides once the top
// rung has no capacity left.
//
// Snapshots default to the sanitised fixtures captured 2026-09-22. Override with:
//   PMR_MODELS, PMR_USAGE, PMR_CODEXBAR  — raw `omp models` / `omp usage` / `codexbar usage` JSON
//   PMR_INTEL                            — Artificial Analysis payload (coding/agentic arrays)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRoutes, selectForTier } from '../../extension/ranking.ts';
import { DEFAULT_POLICY } from '../../extension/policy.ts';
import { computeLadders } from '../../extension/rungs.ts';
import { normalizeOmpUsage, parseCodexBarRows } from '../../extension/telemetry.ts';
import type { IntelMap } from '../../extension/openrouter-intel.ts';
import type { OmpModelLike } from '../../extension/ranking.ts';
import type { NormalizedRoute, Tier } from '../../extension/types.ts';

interface BenchmarkRow {
  permaslug?: string;
  heuristic_openrouter_slug?: string | null;
  score?: number;
}

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const MODELS_FILE = process.env.PMR_MODELS ?? `${FIXTURES}live-omp-models-2026-09-22.json`;
const USAGE_FILE = process.env.PMR_USAGE ?? `${FIXTURES}live-omp-usage-2026-09-22.json`;
const CODEXBAR_FILE = process.env.PMR_CODEXBAR ?? `${FIXTURES}live-codexbar-2026-09-22.json`;
const INTEL_FILE = process.env.PMR_INTEL ?? `${FIXTURES}aa-bench-2026-09-22.json`;
const NOW = Date.parse(process.env.PMR_NOW ?? '2026-09-22T22:00:00.000Z');
const TIERS: Tier[] = ['frontier', 'balanced', 'small', 'free'];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Boundary read #1: `omp models --json` is `{ models: [...] }`; fields are consumed via OmpModelLike. */
function modelCatalog(raw: unknown): OmpModelLike[] {
  if (!raw || typeof raw !== 'object' || !('models' in raw) || !Array.isArray(raw.models)) {
    throw new Error(`${MODELS_FILE}: expected { models: [...] }`);
  }
  const models = raw.models;
  return models as OmpModelLike[];
}

/** Boundary read #2: the benchmark payload is `{ coding: [...], agentic: [...] }`. */
function benchmarkRows(raw: unknown, kind: 'coding' | 'agentic'): BenchmarkRow[] {
  if (!raw || typeof raw !== 'object' || !(kind in raw)) return [];
  const rows = raw[kind];
  return Array.isArray(rows) ? (rows as BenchmarkRow[]) : [];
}

// The Data API normaliser (openrouter-intel.ts normalizeBenchmarkRows) stores a benchmark index
// as a 0..1 fraction keyed by the model's OpenRouter slug; this mirrors that shape.
function intelFromPayload(raw: unknown): IntelMap {
  const intel: IntelMap = {};
  for (const kind of ['coding', 'agentic'] as const) {
    for (const row of benchmarkRows(raw, kind)) {
      if (typeof row.score !== 'number') continue;
      for (const slug of [row.permaslug, row.heuristic_openrouter_slug]) {
        if (typeof slug !== 'string') continue;
        const key = slug.toLowerCase();
        intel[key] = { ...(intel[key] ?? {}), [kind]: row.score / 100 };
      }
    }
  }
  return intel;
}

const models = modelCatalog(readJson(MODELS_FILE));
const ompReports = normalizeOmpUsage(readJson(USAGE_FILE));
const codexbar = parseCodexBarRows(readJson(CODEXBAR_FILE) as unknown[]);
const intel = intelFromPayload(readJson(INTEL_FILE));

const routes = buildRoutes(models, { ompReports, codexbar, localState: {}, history: {}, intel, reservePct: 10, now: NOW });
const ladders = computeLadders(DEFAULT_POLICY, routes);
const measured = routes.filter((route) => route.benchmarkPower !== undefined).length;

console.log(`catalog routes: ${routes.length}; snapshot slugs: ${Object.keys(intel).length}; measured routes: ${measured}`);

function chain(order: string[], steps = 6): string[] {
  const working: NormalizedRoute[] = routes.map((route) => ({ ...route }));
  const picks: string[] = [];
  for (let step = 0; step < steps; step++) {
    const pick = selectForTier(working, order, { allowDraining: true });
    if (!pick) break;
    picks.push(`${pick.route.key} [${pick.className}]`);
    const index = working.findIndex((route) => route.key === pick.route.key);
    const winner = working[index];
    if (index < 0 || winner === undefined) break;
    working[index] = { ...winner, health: { ...winner.health, state: 'COOLDOWN' } };
  }
  return picks;
}

let changedTiers = 0;
for (const tier of TIERS) {
  const shipped = DEFAULT_POLICY.tiers[tier].classes;
  const computed = ladders[tier].order;
  const sameOrder = shipped.join('>') === computed.join('>');
  if (!sameOrder) changedTiers += 1;
  console.log(`\n=== ${tier} (${ladders[tier].source})`);
  console.log(`  shipped : ${shipped.join(' > ')}`);
  console.log(`  computed: ${computed.join(' > ')}${sameOrder ? '   (unchanged)' : ''}`);
  const powers = Object.entries(ladders[tier].powers).sort((a, b) => b[1] - a[1]);
  console.log(`  powers  : ${powers.map(([name, power]) => `${name}=${power.toFixed(3)}`).join(' ')}`);
  console.log(`  pinned  : ${ladders[tier].unmeasured.join(' ') || '-'}`);
  const before = chain(shipped);
  const after = chain(computed);
  for (let step = 0; step < Math.max(before.length, after.length); step++) {
    const b = before[step] ?? '(none)';
    const a = after[step] ?? '(none)';
    console.log(`  fallback ${step + 1}: ${b === a ? 'same     ' : 'DIFFERENT'} | before ${b} | after ${a}`);
  }
}

console.log(`\ntiers whose ladder changed: ${changedTiers} of ${TIERS.length}`);
