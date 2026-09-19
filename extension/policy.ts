import type { RouterPolicy, SessionIdentity, Tier } from './types.ts';


export const DEFAULT_POLICY: RouterPolicy = {
  tiers: {
    frontier: { classes: ['fable-sub', 'astra-sub', 'opus-sub', 'opus-ish-sub', 'strong-flash-sub', 'strong-chinese', 'best-free'] },
    balanced: { classes: ['sonnet-sub', 'luna-sub', 'chinese-flash-payg', 'free-chinese-flash', 'best-available', 'healthy-free'] },
    small: { classes: ['cheap-sub', 'cheap-flash', 'healthy-free-fast'] },
  },
  agentTiers: {
    architect: 'frontier',
    reviewer: 'frontier',
    scout: 'small',
    librarian: 'small',
  },
};

export interface RouteEconomics {
  free: boolean;
  subscriptionLike: boolean;
}

export function tierForRole(role: string | undefined): Tier {
  if (role === 'plan' || role === 'advisor' || role === 'slow') return 'frontier';
  if (role === 'smol' || role === 'tiny') return 'small';
  return 'balanced';
}

export function tierForSession(
  session: SessionIdentity,
  agentTiers: Record<string, Tier> = {},
): Tier {
  if (session.agent && agentTiers[session.agent]) return agentTiers[session.agent];
  return tierForRole(session.modelRole);
}

export function classifyModelId(selector: string): string[] {
  const s = selector.toLowerCase().replace(/^~/, '');
  const out = new Set<string>();

  if (s.includes('fable')) out.add('fable');
  if (s.includes('astra')) out.add('astra');
  if (s.includes('opus')) out.add('opus');
  if (s.includes('mythos')) out.add('opus-ish');
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

export function normalizePolicy(raw: any): import('./types.ts').RouterPolicy {
  const tiers = {
    frontier: { classes: Array.isArray(raw?.tiers?.frontier?.classes) ? raw.tiers.frontier.classes.map(String) : [...DEFAULT_POLICY.tiers.frontier.classes] },
    balanced: { classes: Array.isArray(raw?.tiers?.balanced?.classes) ? raw.tiers.balanced.classes.map(String) : [...DEFAULT_POLICY.tiers.balanced.classes] },
    small: { classes: Array.isArray(raw?.tiers?.small?.classes) ? raw.tiers.small.classes.map(String) : [...DEFAULT_POLICY.tiers.small.classes] },
  };
  const agentTiers: Record<string, Tier> = { ...(DEFAULT_POLICY.agentTiers ?? {}) };
  for (const [name, value] of Object.entries(raw?.agentTiers ?? {})) {
    if (value === 'frontier' || value === 'balanced' || value === 'small') agentTiers[name] = value;
  }
  return { tiers, agentTiers };
}
