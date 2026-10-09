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

/**
 * A non-2xx Data API answer. A 429 carries the reset the header advertised (epoch ms) and whether
 * the body names the per-day account quota (`datasets-per-account-rpd-v1`, observed live).
 */
class DataApiHttpError extends Error {
  constructor(readonly status: number, readonly resetAt: number | undefined, readonly dailyQuota: boolean) {
    super(`OpenRouter Data API HTTP ${status}`);
  }
}

function parseResetHeader(value: string | null): number | undefined {
  const n = value === null ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Observed live as epoch milliseconds; accept epoch seconds too.
  return n < 1e12 ? n * 1000 : n;
}

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    headers: buildOpenRouterHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new DataApiHttpError(
      response.status,
      parseResetHeader(response.headers.get('x-ratelimit-reset')),
      /\brpd\b|-rpd-|per[- ]day|requests\/day/i.test(body),
    );
  }
  return await response.json() as T;
}

/** No block outlives the per-day quota it stands for, whatever a header or a file claims. */
const MAX_BLOCK_MS = 24 * 60 * 60_000;

function nextUtcDay(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/**
 * When a 429 lets the next request through: the advertised reset (live 2026-10-09: the next 00:00
 * UTC), bounded to a day. Without a usable reset only the named per-day quota earns a block until
 * the next UTC day; any other 429 (a per-minute burst) is left to the 15-minute retry floor.
 */
function rateLimitedUntil(error: unknown, now: number): number | undefined {
  if (!(error instanceof DataApiHttpError) || error.status !== 429) return undefined;
  if (error.resetAt !== undefined && error.resetAt > now) return Math.min(error.resetAt, now + MAX_BLOCK_MS);
  return error.dailyQuota ? nextUtcDay(now) : undefined;
}

function yyyyMmDd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface IntelCache {
  data: IntelMap;
  fetchedAt: number;
  lastAttemptAt: number;
  /** Set by a Data API 429: no request is made before this instant (epoch ms). */
  blockedUntil?: number;
}

/**
 * Combine this process's cache with a peer's (the intel file is shared by every OMP process on the
 * machine, and the Data API budget is shared by the whole account): the newer snapshot wins, and
 * the latest attempt and the latest block apply to everyone.
 */
export function mergeIntelCache(ours: IntelCache, theirs: IntelCache): IntelCache {
  const newer = theirs.fetchedAt > ours.fetchedAt ? theirs : ours;
  const blockedUntil = Math.max(ours.blockedUntil ?? 0, theirs.blockedUntil ?? 0);
  const merged: IntelCache = {
    data: newer.data,
    fetchedAt: newer.fetchedAt,
    lastAttemptAt: Math.max(ours.lastAttemptAt, theirs.lastAttemptAt),
  };
  if (blockedUntil > 0) merged.blockedUntil = blockedUntil;
  return merged;
}

/**
 * Make a cache read from disk safe to gate on (corrupt or hand-edited file, clock stepped back):
 * drop an expired block and cap one that claims more than a day, and treat a snapshot or attempt
 * time ahead of now as unknown (0). A future time would otherwise read as "just now" forever and,
 * because merges keep the maximum, survive every save.
 */
export function boundIntelCache(cache: IntelCache, now = Date.now()): IntelCache {
  const { blockedUntil, ...rest } = cache;
  const bounded: IntelCache = {
    ...rest,
    fetchedAt: Number.isFinite(rest.fetchedAt) && rest.fetchedAt <= now ? rest.fetchedAt : 0,
    lastAttemptAt: Number.isFinite(rest.lastAttemptAt) && rest.lastAttemptAt <= now ? rest.lastAttemptAt : 0,
  };
  if (blockedUntil === undefined || !Number.isFinite(blockedUntil) || blockedUntil <= now) return bounded;
  return { ...bounded, blockedUntil: Math.min(blockedUntil, now + MAX_BLOCK_MS) };
}

export const EMPTY_INTEL_CACHE: IntelCache = { data: {}, fetchedAt: 0, lastAttemptAt: 0 };
export const INTEL_TTL_MS = 6 * 60 * 60_000;
export const INTEL_RETRY_FLOOR_MS = 15 * 60_000;

/** Whether a refresh may spend Data API requests now: not blocked, snapshot stale, retry floor passed. */
export function intelRefreshDue(cache: IntelCache, now = Date.now()): boolean {
  if (cache.blockedUntil && now < cache.blockedUntil) return false;
  if (cache.fetchedAt && now - cache.fetchedAt < INTEL_TTL_MS) return false;
  if (cache.lastAttemptAt && now - cache.lastAttemptAt < INTEL_RETRY_FLOOR_MS) return false;
  return true;
}

/**
 * Spend one refresh (four Data API requests). The caller has checked `intelRefreshDue` and owns
 * the machine-wide claim; this only fetches and records the outcome.
 */
export async function fetchOpenRouterIntel(apiKey: string, cache: IntelCache, now = Date.now()): Promise<IntelCache> {
  const attempted = { ...cache, lastAttemptAt: now };
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
  } catch (error) {
    const blockedUntil = rateLimitedUntil(error, now);
    return blockedUntil === undefined ? attempted : { ...attempted, blockedUntil };
  }
}
