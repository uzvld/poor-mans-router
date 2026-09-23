import type { IntelMap } from './openrouter-intel.ts';
import type { NormalizedRoute, RouterPolicy, Tier } from './types.ts';

// Rung strength is measured, not named. A class's power is the best benchmark power among the
// routes that carry it, and each tier's ladder is re-derived from that measurement once per
// intel refresh — never per turn, so the order cannot flap mid-conversation.
//
// Five rules decide what the data is allowed to move, and nothing else moves:
//   1. capability rungs are ordered by measured power (the point of the exercise);
//   2. an unmeasured class never gains position from being unmeasured: it is pinned to the index
//      the shipped policy gave it, and measured classes fill the slots around it (AGENTS.md I7);
//   3. a catch-all class — one whose members are a superset of another class in the same ladder —
//      is a tail, not a rung, and keeps its shipped index. `best-available` holds every paid
//      route, so ordering it by its best member would let the most expensive model in the
//      catalog jump the queue of every tier it appears in;
//   4. rungs that sell the way the user pays differently never cross on power alone: a paid rung
//      does not displace a subscription rung, and neither displaces a free one. Economics stays
//      first-order policy (this router is subscription-first); capability orders what economics
//      has already grouped. A mixed class may cross a pure paid class, but never a pure
//      subscription or free rung; subscription-first remains absolute.
//   5. `selectForTier` still walks the resulting order strictly, so a lower rung never wins while
//      a higher one has an AVAILABLE route — recomputing the order does not weaken that (I1).
//
// `RUNG_HYSTERESIS` is the smallest power gap that may reorder two rungs. Measured gaps between
// neighbouring capability classes on the 2026-09-22 snapshot are 2–10 points; a 2-point floor
// therefore admits every real ordering difference in the data while refusing snapshot-to-snapshot
// wobble. It is a policy constant, not a fitted value: recalibrating it needs two snapshots of
// the same day, which the Data API's quota (500 requests/account/day) makes a daily decision.

export const RUNG_HYSTERESIS = 0.02;

/** Capability blend, mirroring the coding:agentic ratio of `qualityFromIntel` (0.24 : 0.14). */
const CAPABILITY_WEIGHTS = { coding: 0.63, agentic: 0.37 };

export type ClassEconomics = 'subscription' | 'paid' | 'free' | 'mixed';

export interface ClassProfile {
  /** Best measured power among the class's routes; undefined when nothing measured the class. */
  power?: number;
  economics: ClassEconomics;
  /** Route keys carrying the class — used to recognise catch-all tails. */
  members: string[];
}

export interface ComputedLadder {
  /** Full class order for the tier: measured rungs reordered, everything else at its shipped index. */
  order: string[];
  /** Best measured power per class, for the classes that were measured at all. */
  powers: Record<string, number>;
  /** Classes with no measured member: pinned, and never a reason to move anything else. */
  unmeasured: string[];
  source: 'snapshot' | 'static';
}

/**
 * Benchmark power of one model, 0..1, or undefined when the snapshot says nothing about it.
 * coding dominates agentic at the same ratio `qualityFromIntel` uses; a model measured on only
 * one of the two is scored on that one rather than being treated as half-measured.
 */
export function benchmarkPower(intel: IntelMap[string] | undefined): number | undefined {
  const coding = intel?.coding;
  const agentic = intel?.agentic;
  if (typeof coding === 'number' && typeof agentic === 'number') {
    return CAPABILITY_WEIGHTS.coding * coding + CAPABILITY_WEIGHTS.agentic * agentic;
  }
  if (typeof coding === 'number') return coding;
  if (typeof agentic === 'number') return agentic;
  return undefined;
}

function economicsOf(route: NormalizedRoute): ClassEconomics {
  if (route.free) return 'free';
  return route.subscriptionLike ? 'subscription' : 'paid';
}

/** Per-class power, economics and membership, across every route in the catalog. */
export function profileClasses(routes: NormalizedRoute[]): Record<string, ClassProfile> {
  const profiles: Record<string, ClassProfile> = {};
  for (const route of routes) {
    for (const className of route.classes) {
      const profile = profiles[className] ?? { economics: 'paid' as ClassEconomics, members: [] };
      if (typeof route.benchmarkPower === 'number' && (profile.power === undefined || route.benchmarkPower > profile.power)) {
        profile.power = route.benchmarkPower;
      }
      const kind = economicsOf(route);
      profile.economics = profile.members.length === 0
        ? kind
        : profile.economics === kind
          ? kind
          : 'mixed';
      profile.members.push(route.key);
      profiles[className] = profile;
    }
  }
  return profiles;
}

/** A class that contains all of another class in the same ladder is a tail, not a rung. */
function catchAllClasses(base: string[], profiles: Record<string, ClassProfile>): Set<string> {
  const out = new Set<string>();
  for (const outer of base) {
    const outerMembers = profiles[outer]?.members ?? [];
    if (outerMembers.length === 0) continue;
    const outerSet = new Set(outerMembers);
    for (const inner of base) {
      if (inner === outer) continue;
      const innerMembers = profiles[inner]?.members ?? [];
      if (!innerMembers.length) continue;
      if (innerMembers.every((key) => outerSet.has(key))) {
        out.add(outer);
        break;
      }
    }
  }
  return out;
}

function swappable(kindA: ClassEconomics, kindB: ClassEconomics): boolean {
  if (kindA === kindB) return true;
  // A mixed class may compete with paid capability classes, but it must not jump a
  // pure subscription or free rung: subscription-first remains absolute across tiers.
  if (kindA === 'subscription' || kindB === 'subscription') return false;
  if (kindA === 'free' || kindB === 'free') return false;
  return true;
}

/**
 * Order one tier's classes by measured power.
 *
 * Eligible classes are inserted in their previous order (or the shipped order on first run), and
 * each one climbs past the class above it only while it wins by at least `RUNG_HYSTERESIS` and
 * the two sell the same way. Gapped insertion keeps the sort total and deterministic: the outcome
 * depends only on the profiles, the previous order and the margin — never on set iteration order
 * or a clock.
 */
export function orderLadder(
  base: string[],
  profiles: Record<string, ClassProfile>,
  previous?: string[],
): ComputedLadder {
  const powers: Record<string, number> = {};
  for (const name of base) {
    const power = profiles[name]?.power;
    if (typeof power === 'number') powers[name] = power;
  }

  const unmeasured = base.filter((name) => typeof powers[name] !== 'number');
  const tails = catchAllClasses(base, profiles);
  const measured = base.filter((name) => typeof powers[name] === 'number' && !tails.has(name));
  if (measured.length < 2) {
    return { order: [...base], powers, unmeasured, source: 'static' };
  }

  const known = new Set(previous ?? base);
  const iteration = [
    ...(previous ?? base).filter((name) => measured.includes(name)),
    ...measured.filter((name) => !known.has(name)),
  ];

  const sorted: string[] = [];
  for (const name of iteration) {
    sorted.push(name);
    for (let index = sorted.length - 1; index > 0; index--) {
      const lower = sorted[index];
      const upper = sorted[index - 1];
      if (lower === undefined || upper === undefined) break;
      const lowerPower = powers[lower] ?? 0;
      const upperPower = powers[upper] ?? 0;
      if (lowerPower - upperPower < RUNG_HYSTERESIS) break;
      const kindBelow = profiles[lower]?.economics ?? 'paid';
      const kindAbove = profiles[upper]?.economics ?? 'paid';
      if (!swappable(kindBelow, kindAbove)) break;
      sorted[index - 1] = lower;
      sorted[index] = upper;
    }
  }

  const order = [...base];
  let next = 0;
  for (const [index, name] of base.entries()) {
    if (typeof powers[name] !== 'number' || tails.has(name)) continue;
    const replacement = sorted[next];
    next += 1;
    if (replacement !== undefined) order[index] = replacement;
  }
  return { order, powers, unmeasured, source: 'snapshot' };
}

/** Ladder for every tier. `previous` carries the last computed ladders so the margin is sticky. */
export function computeLadders(
  policy: RouterPolicy,
  routes: NormalizedRoute[],
  previous: Partial<Record<Tier, string[]>> = {},
): Record<Tier, ComputedLadder> {
  const profiles = profileClasses(routes);
  return {
    frontier: orderLadder(policy.tiers.frontier.classes, profiles, previous.frontier),
    balanced: orderLadder(policy.tiers.balanced.classes, profiles, previous.balanced),
    small: orderLadder(policy.tiers.small.classes, profiles, previous.small),
    free: orderLadder(policy.tiers.free.classes, profiles, previous.free),
  };
}
