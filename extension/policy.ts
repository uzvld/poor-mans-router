import type { FacetWeights } from './bench-types.ts';
import { isFiniteNumber, isRecord } from './bench-util.ts';
import type { RouterPolicy, Tier } from './types.ts';

/**
 * How much each benchmark facet counts in a tier (coding / agentic / general). Frontier is hard agentic
 * work, balanced is strong work at a fair price (the price is already decided by class economics), small
 * is speed and price with the benchmark only breaking ties; `free` keeps balanced's weights and its own
 * value preference (docs/design.md §10.1). Judgment, not measurement: policy.yml overrides them.
 */
export const DEFAULT_WEIGHTS: Record<Tier, FacetWeights> = {
  frontier: { coding: 0.4, agentic: 0.45, general: 0.15 },
  balanced: { coding: 0.45, agentic: 0.35, general: 0.2 },
  small: { coding: 0.4, agentic: 0.2, general: 0.4 },
  free: { coding: 0.45, agentic: 0.35, general: 0.2 },
};

export const DEFAULT_POLICY: RouterPolicy = {
  tiers: {
    frontier: { classes: ['fable-sub', 'astra-sub', 'opus-sub', 'opus-ish-sub', 'strong-flash-sub', 'strong-chinese', 'best-free'] },
    balanced: { classes: ['sonnet-sub', 'luna-sub', 'chinese-flash-payg', 'free-chinese-flash', 'best-available', 'healthy-free'] },
    small: { classes: ['cheap-sub', 'cheap-flash', 'healthy-free-fast'] },
    // Free-only by contract: the selector promises no spend, so no paid rung here.
    free: { classes: ['best-free', 'free-chinese-flash', 'healthy-free-fast', 'healthy-free'] },
  },
  weights: DEFAULT_WEIGHTS,
};

export interface RouteEconomics {
  free: boolean;
  subscriptionLike: boolean;
}

export function classifyModelId(selector: string): string[] {
  const s = selector.toLowerCase().replace(/^~/, '');
  const out = new Set<string>();

  if (s.includes('fable')) out.add('fable');
  if (s.includes('astra')) out.add('astra');
  if (s.includes('opus')) out.add('opus');
  if (s.includes('mythos')) out.add('opus-ish');
  // `sol` / `terra` (OpenAI code names) are word-bounded: the catalog really contains
  // `upstage/solar-pro-*` and `alfredpros/codellama-7b-instruct-solidity`, which a bare
  // `includes('sol')` would drag into a frontier rung.
  if (/(?:^|[-_/])(?:sol|terra)(?![a-z0-9])/.test(s)) out.add('opus-ish');
  if (s.includes('sonnet')) out.add('sonnet');
  if (s.includes('haiku') || s.includes('spark')) out.add('cheap');
  if (s.includes('luna')) {
    out.add('luna');
    out.add('cheap');
  }

  const chinese = ['deepseek', 'glm', 'qwen', 'kimi', 'minimax'].some((name) => s.includes(name));
  if (chinese) out.add('chinese');

  if (s.includes('flash')) {
    out.add('flash');
    if (chinese) out.add('chinese-flash');
  }

  if (
    s.includes('deepseek-v4-pro') ||
    s.includes('deepseek/deepseek-v4-pro') ||
    /glm[-_/]?5(?:\.\d)?(?!.*flash)/.test(s) ||
    s.includes('qwen3-max') ||
    s.includes('qwen-max')
  ) {
    out.add('strong-chinese');
  }

  if (s.endsWith(':free') || s.includes('/free') || s.includes('auto-free')) out.add('free');
  return [...out];
}

export function decorateClasses(base: string[], economics: RouteEconomics): string[] {
  const tags = new Set(base);

  if (economics.free) {
    // Strong free models belong in the explicit free tail, not the paid/subscription strong-model class.
    tags.delete('strong-chinese');
    tags.add('best-free');
    tags.add('healthy-free');
    tags.add('healthy-free-fast');
    if (tags.has('chinese-flash')) tags.add('free-chinese-flash');
    return [...tags];
  }

  tags.add('best-available');

  if (economics.subscriptionLike) {
    if (tags.has('fable')) tags.add('fable-sub');
    if (tags.has('astra')) tags.add('astra-sub');
    if (tags.has('opus')) tags.add('opus-sub');
    if (tags.has('opus-ish')) tags.add('opus-ish-sub');
    if (tags.has('sonnet')) tags.add('sonnet-sub');
    if (tags.has('luna')) tags.add('luna-sub');
    if (tags.has('flash')) {
      tags.add('strong-flash-sub');
      tags.add('cheap-sub');
    }
    if (tags.has('cheap')) tags.add('cheap-sub');
  } else {
    if (tags.has('chinese-flash')) tags.add('chinese-flash-payg');
    if (tags.has('flash')) tags.add('cheap-flash');
  }

  if (tags.has('strong-chinese')) tags.add('strong-chinese');
  return [...tags];
}

/** Three finite, non-negative weights that sum to something; anything else is not a weight set. */
function weightsOf(value: unknown): FacetWeights | undefined {
  if (!isRecord(value)) return undefined;
  const { coding, agentic, general } = value;
  if (!isFiniteNumber(coding) || !isFiniteNumber(agentic) || !isFiniteNumber(general)) return undefined;
  if (coding < 0 || agentic < 0 || general < 0 || coding + agentic + general <= 0) return undefined;
  return { coding, agentic, general };
}

export function normalizePolicy(raw: unknown): RouterPolicy {
  const tiers = isRecord(raw) && isRecord(raw.tiers) ? raw.tiers : {};
  const weights = isRecord(raw) && isRecord(raw.weights) ? raw.weights : {};
  const classesOf = (tier: Tier): string[] => {
    const entry = tiers[tier];
    return isRecord(entry) && Array.isArray(entry.classes) ? entry.classes.map(String) : [...DEFAULT_POLICY.tiers[tier].classes];
  };
  const weightsFor = (tier: Tier): FacetWeights => weightsOf(weights[tier]) ?? { ...DEFAULT_WEIGHTS[tier] };
  return {
    tiers: {
      frontier: { classes: classesOf('frontier') },
      balanced: { classes: classesOf('balanced') },
      small: { classes: classesOf('small') },
      free: { classes: classesOf('free') },
    },
    weights: { frontier: weightsFor('frontier'), balanced: weightsFor('balanced'), small: weightsFor('small'), free: weightsFor('free') },
  };
}
