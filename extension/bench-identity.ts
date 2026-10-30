import type { Effort } from './bench-types.ts';

// Four sources, four spellings of one model:
//   LMArena  `Claude Sonnet 5.5 (xHigh)`  + organization `Anthropic`
//   Epoch    `claude-sonnet-5-5_max`
//   BenchLM  `claude-sonnet-5-5`          + creator `Anthropic`
//   AA       `anthropic/claude-sonnet-5.5-20260928`
// They all reduce to `anthropic/claude-sonnet-5.5`: vendor/slug, lower case, dotted versions, no
// effort, no release date. The key only has to be equal across sources: routes are still matched
// through `intelAliases`, which reads either spelling.

const EFFORTS: Record<string, Effort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'extra high': 'xhigh',
  'extra-high': 'xhigh',
  max: 'max',
};

const ORGANIZATIONS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'google deepmind': 'google',
  deepmind: 'google',
  meta: 'meta',
  'meta ai': 'meta',
  xai: 'x-ai',
  'x-ai': 'x-ai',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  'moonshot ai': 'moonshotai',
  moonshotai: 'moonshotai',
  alibaba: 'qwen',
  'alibaba cloud': 'qwen',
  qwen: 'qwen',
  zhipu: 'z-ai',
  'zhipu ai': 'z-ai',
  'z.ai': 'z-ai',
  'z-ai': 'z-ai',
  zai: 'z-ai',
  mistral: 'mistralai',
  'mistral ai': 'mistralai',
  mistralai: 'mistralai',
  minimax: 'minimax',
  xiaomi: 'xiaomi',
  nvidia: 'nvidia',
  stepfun: 'stepfun',
  cohere: 'cohere',
  'thinking machines': 'thinkingmachines',
  thinkingmachines: 'thinkingmachines',
  thinky: 'thinkingmachines',
  upstage: 'upstage',
  amazon: 'amazon',
  microsoft: 'microsoft',
};

/** Vendor by family prefix, for sources that carry no organization column (Epoch's `Model version`). */
const FAMILY_VENDORS: Array<[RegExp, string]> = [
  [/^claude/, 'anthropic'],
  [/^(?:gpt|o\d)/, 'openai'],
  [/^(?:gemini|gemma)/, 'google'],
  [/^grok/, 'x-ai'],
  [/^deepseek/, 'deepseek'],
  [/^qwen/, 'qwen'],
  [/^glm/, 'z-ai'],
  [/^kimi/, 'moonshotai'],
  [/^(?:llama|muse)/, 'meta'],
  [/^(?:mistral|mixtral|codestral|magistral|devstral)/, 'mistralai'],
  [/^minimax/, 'minimax'],
  [/^mimo/, 'xiaomi'],
  [/^nemotron/, 'nvidia'],
  [/^step/, 'stepfun'],
  [/^command/, 'cohere'],
];

const EPOCH_EFFORT_SUFFIX = /_(low|medium|high|xhigh|max|unknown)$/i;

/**
 * Canonical key and reasoning effort of a benchmark row's model, or undefined when the vendor
 * cannot be determined: a row keyed under a guess would blend into the wrong model, a dropped row
 * only leaves a model measured by fewer sources.
 */
export function canonicalBenchModel(name: string, organization?: string): { model: string; effort?: Effort } | undefined {
  let text = name.trim();
  if (!text) return undefined;

  let vendor: string | undefined;
  const slash = text.indexOf('/');
  if (slash > 0) {
    vendor = text.slice(0, slash).toLowerCase();
    text = text.slice(slash + 1);
  }

  let effort: Effort | undefined;
  const suffix = text.match(EPOCH_EFFORT_SUFFIX);
  if (suffix) {
    const level = (suffix[1] as string).toLowerCase();
    if (level !== 'unknown') effort = level as Effort;
    text = text.slice(0, suffix.index);
  }

  // `(xHigh)`, `(High, 32K, 20251101)`, `(20250929)`: effort is read, budgets and dates are noise.
  text = text.replace(/\(([^)]*)\)/g, (_all, inner: string) => {
    for (const token of inner.split(',')) {
      const level = EFFORTS[token.trim().toLowerCase()];
      if (level) effort = level;
    }
    return ' ';
  });

  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-_:~]/g, '')
    .replace(/^~/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    // Dotted versions everywhere (`5-5` → `5.5`): the key must read the same in every source.
    .replace(/(?<=\d)-(?=\d)/g, '.');
  if (!slug) return undefined;

  vendor ??= (organization ? ORGANIZATIONS[organization.trim().toLowerCase()] : undefined)
    ?? FAMILY_VENDORS.find(([pattern]) => pattern.test(slug))?.[1];
  if (!vendor) return undefined;

  return effort ? { model: `${vendor}/${slug}`, effort } : { model: `${vendor}/${slug}` };
}
