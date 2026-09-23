export interface ModelIntel {
  coding?: number;
  agentic?: number;
  taskFit?: number;
  popularity?: number;
}

export type IntelMap = Record<string, ModelIntel>;

export function buildOpenRouterHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function resolveOpenRouterKey(ctx: any): Promise<string | undefined> {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const key = await ctx?.modelRegistry?.getApiKeyForProvider?.('openrouter', sessionId);
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function stripVariants(id: string): string {
  return id
    .replace(/^~/, '')
    .replace(/:(free|discounted|batch|extended)$/i, '');
}

export function canonicalModelSlug(provider: string, modelId: string): string {
  const id = stripVariants(modelId.toLowerCase());
  if (id.includes('/')) return id;

  if (provider === 'anthropic' || id.startsWith('claude-')) return `anthropic/${id}`;
  if (provider === 'openai-codex' || id.startsWith('gpt-')) return `openai/${id}`;
  if (id.startsWith('deepseek-')) return `deepseek/${id}`;
  if (id.startsWith('glm-')) return `z-ai/${id}`;
  if (id.startsWith('qwen')) return `qwen/${id}`;
  if (id.startsWith('kimi-')) return `moonshotai/${id}`;
  return `${provider}/${id}`;
}

function boundedScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, normalized));
}

// --- Intel key matching -------------------------------------------------------------------------
// The snapshot keys a model by its OpenRouter release slug, the catalog by its OMP id, and the two
// disagree in three measured ways: the snapshot carries a release date the catalog usually does not
// (`anthropic/claude-fable-5.1-20260831` vs `anthropic/claude-fable-5-1`), a Claude version is
// dotted on one side and dashed on the other (`claude-opus-5.5` vs `claude-opus-5-5`), and some
// providers ship bare ids whose vendor OpenRouter names differently (`opencode-go/grok-4.6` vs
// `x-ai/grok-4.6`). Measured on the live catalog 2026-09-23: the coding index reached 87 of 1203
// routes while 331 were reachable. These aliases bridge the three without rewriting the stored
// keys, so every existing consumer keeps the key shape it already reads.

const VERSION_SEPARATOR = /(?<=\d)[.-](?=\d)/g;

/** Key spellings a snapshot row and a catalog route may disagree on, most specific first. */
export function intelAliases(slug: string): string[] {
  const stripped = stripVariants(slug.toLowerCase());
  const undated = stripped.replace(/-\d{8}$/, '');
  // `-discounted` is the dash spelling of the `:discounted` variant `stripVariants` already folds:
  // same model, different price. `-pro`/`-mini`/`-fast` are distinct SKUs and are never folded.
  const base = undated.replace(/-(?:discounted|extended)$/, '');
  const out: string[] = [];
  for (const candidate of [stripped, undated, base]) {
    for (const spelling of [
      candidate,
      candidate.replace(VERSION_SEPARATOR, '.'),
      candidate.replace(VERSION_SEPARATOR, '-'),
    ]) {
      if (!out.includes(spelling)) out.push(spelling);
    }
  }
  return out;
}

function releaseDate(slug: string): string {
  const match = stripVariants(slug.toLowerCase()).match(/-(\d{8})$/);
  return match?.[1] ?? '';
}

export interface IntelLookup {
  /** Keyed by every alias above, newest release wins when two keys describe one model. */
  exact: IntelMap;
  /** Basename of a unique model name, for providers that ship no vendor prefix. */
  byBasename: Record<string, string>;
}

export function buildIntelLookup(intel: IntelMap): IntelLookup {
  const exact: IntelMap = {};
  const dates: Record<string, string> = {};
  const sources: Record<string, Set<string>> = {};

  for (const [rawKey, value] of Object.entries(intel)) {
    const aliases = intelAliases(rawKey);
    const date = releaseDate(rawKey);
    for (const alias of aliases) {
      const known = dates[alias];
      if (known === undefined || date >= known) {
        exact[alias] = { ...(exact[alias] ?? {}), ...value };
        if (date) dates[alias] = date;
      }
    }
    const first = aliases[0];
    for (const alias of aliases) {
      const basename = alias.split('/').pop();
      if (basename && first) (sources[basename] ??= new Set()).add(first);
    }
  }

  const byBasename: Record<string, string> = {};
  for (const [basename, keys] of Object.entries(sources)) {
    // Two different models sharing a bare name would make the fallback a guess; it is not one.
    if (keys.size === 1) byBasename[basename] = [...keys][0] as string;
  }
  return { exact, byBasename };
}

/** Intel for one catalog route, or undefined when nothing measured it. */
export function intelForRoute(lookup: IntelLookup, provider: string, modelId: string): ModelIntel | undefined {
  const canonical = canonicalModelSlug(provider, modelId);
  for (const alias of intelAliases(canonical)) {
    const hit = lookup.exact[alias];
    if (hit) return hit;
  }
  const basename = stripVariants(canonical.toLowerCase()).split('/').pop();
  if (!basename) return undefined;
  for (const alias of intelAliases(basename)) {
    const key = lookup.byBasename[alias];
    if (key) return lookup.exact[key];
  }
  return undefined;
}

export function normalizeBenchmarkRows(payload: any, kind: 'coding' | 'agentic'): IntelMap {
  const out: IntelMap = {};
  for (const row of payload?.data ?? []) {
    const slug = typeof row?.model_permaslug === 'string' ? stripVariants(row.model_permaslug.toLowerCase()) : undefined;
    if (!slug) continue;
    const raw = kind === 'coding' ? row.coding_index : row.agentic_index;
    const score = boundedScore(raw);
    if (score !== undefined) out[slug] = { [kind]: score };
  }
  return out;
}

export function normalizeTaskClassifications(payload: any): IntelMap {
  const out: IntelMap = {};
  const codeLike = /code|coding|software|programming|developer/i;
  const classifications = Array.isArray(payload?.data?.classifications)
    ? payload.data.classifications
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  for (const classification of classifications) {
    const label = [
      classification?.tag,
      classification?.display_name,
      classification?.macro_category,
      classification?.classification,
      classification?.name,
    ].filter(Boolean).join(' ');
    if (!codeLike.test(label)) continue;
    for (const row of classification?.models ?? []) {
      const rawId = row?.id ?? row?.model_permaslug;
      const slug = typeof rawId === 'string' ? stripVariants(rawId.toLowerCase()) : undefined;
      if (!slug) continue;
      const share = boundedScore(row?.tag_usage_share ?? row?.tag_token_share ?? row?.usage_share);
      if (share === undefined) continue;
      out[slug] = { taskFit: Math.max(out[slug]?.taskFit ?? 0, share) };
    }
  }
  return out;
}

export function normalizeRankingRows(payload: any): IntelMap {
  const totals = new Map<string, number>();
  for (const row of payload?.data ?? []) {
    const slug = typeof row?.model_permaslug === 'string' ? stripVariants(row.model_permaslug.toLowerCase()) : undefined;
    const tokens = typeof row?.total_tokens === 'number'
      ? row.total_tokens
      : typeof row?.total_tokens === 'string'
        ? Number(row.total_tokens)
        : 0;
    if (!slug || slug === 'other' || !Number.isFinite(tokens) || tokens <= 0) continue;
    totals.set(slug, (totals.get(slug) ?? 0) + tokens);
  }
  const logs = [...totals.values()].map((v) => Math.log1p(v));
  const max = logs.length ? Math.max(...logs) : 0;
  const out: IntelMap = {};
  for (const [slug, total] of totals) {
    out[slug] = { popularity: max > 0 ? Math.log1p(total) / max : 0 };
  }
  return out;
}

export function mergeOpenRouterIntel(...maps: IntelMap[]): IntelMap {
  const out: IntelMap = {};
  for (const map of maps) {
    for (const [slug, intel] of Object.entries(map)) out[slug] = { ...(out[slug] ?? {}), ...intel };
  }
  return out;
}

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    headers: buildOpenRouterHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenRouter Data API HTTP ${response.status}`);
  return await response.json() as T;
}

function yyyyMmDd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface IntelCache {
  data: IntelMap;
  fetchedAt: number;
  lastAttemptAt: number;
}

export const EMPTY_INTEL_CACHE: IntelCache = { data: {}, fetchedAt: 0, lastAttemptAt: 0 };
export const INTEL_TTL_MS = 6 * 60 * 60_000;
export const INTEL_RETRY_FLOOR_MS = 15 * 60_000;

export async function refreshOpenRouterIntel(
  ctx: any,
  cache: IntelCache,
  now = Date.now(),
): Promise<IntelCache> {
  if (cache.fetchedAt && now - cache.fetchedAt < INTEL_TTL_MS) return cache;
  if (cache.lastAttemptAt && now - cache.lastAttemptAt < INTEL_RETRY_FLOOR_MS) return cache;

  const attempted = { ...cache, lastAttemptAt: now };
  const apiKey = await resolveOpenRouterKey(ctx);
  if (!apiKey) return attempted;

  const end = new Date(now - 24 * 60 * 60_000);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60_000);
  const base = 'https://openrouter.ai/api/v1';

  try {
    const [coding, agentic, tasks, rankings] = await Promise.all([
      getJson<any>(`${base}/benchmarks?source=artificial-analysis&task_type=coding`, apiKey),
      getJson<any>(`${base}/benchmarks?source=artificial-analysis&task_type=agentic`, apiKey),
      getJson<any>(`${base}/classifications/task?window=7d`, apiKey),
      getJson<any>(`${base}/datasets/rankings-daily?start_date=${yyyyMmDd(start)}&end_date=${yyyyMmDd(end)}`, apiKey),
    ]);

    return {
      data: mergeOpenRouterIntel(
        normalizeBenchmarkRows(coding, 'coding'),
        normalizeBenchmarkRows(agentic, 'agentic'),
        normalizeTaskClassifications(tasks),
        normalizeRankingRows(rankings),
      ),
      fetchedAt: now,
      lastAttemptAt: now,
    };
  } catch {
    return attempted;
  }
}
