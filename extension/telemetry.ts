export interface UsageWindow {
  id: string;
  shared: boolean;
  tier?: string;
  usedFraction?: number;
  remainingFraction?: number;
  resetsAt?: number;
  status?: string;
}

export interface OmpCredentialUsage {
  provider: string;
  credentialKey: string;
  fetchedAt: number;
  windows: UsageWindow[];
}

export interface CodexBarUsage {
  provider: string;
  telemetryAvailable: boolean;
  exhausted: boolean;
  /** Which window kind vetoed: a refilling `allowance` or a top-up-only `balance`. */
  exhaustionScope?: 'allowance' | 'balance';
  draining: boolean;
  /** Which window kind forecast the drain: `allowance` or `balance`. */
  drainingScope?: 'allowance' | 'balance';
  blockedUntil?: number;
  paidBalanceUsd?: number;
  paidBalanceKnown: boolean;
  fetchedAt: number;
  reason?: string;
}

const CODEXBAR_PROVIDER_ALIASES: Record<string, string> = {
  codex: 'openai-codex',
  claude: 'anthropic',
  opencodego: 'opencode-go',
};

export function canonicalTelemetryProvider(provider: string): string {
  return CODEXBAR_PROVIDER_ALIASES[provider] ?? provider;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fractionFromAmount(amount: any): number | undefined {
  const direct = asNumber(amount?.remainingFraction);
  if (direct !== undefined) return direct;
  const remaining = asNumber(amount?.remaining);
  const limit = asNumber(amount?.limit);
  if (remaining !== undefined && limit && limit > 0) return remaining / limit;
  const usedFraction = asNumber(amount?.usedFraction);
  if (usedFraction !== undefined) return Math.max(0, 1 - usedFraction);
  return undefined;
}

export function normalizeOmpUsage(raw: any): OmpCredentialUsage[] {
  const reports = Array.isArray(raw?.reports) ? raw.reports : [];
  const perProviderIndex = new Map<string, number>();

  return reports.map((report: any) => {
    const provider = String(report?.provider ?? 'unknown');
    const n = (perProviderIndex.get(provider) ?? 0) + 1;
    perProviderIndex.set(provider, n);

    const windows: UsageWindow[] = (Array.isArray(report?.limits) ? report.limits : []).map((limit: any) => ({
      id: String(limit?.scope?.windowId ?? limit?.window?.id ?? limit?.id ?? 'unknown'),
      shared: limit?.scope?.shared === true,
      tier: typeof limit?.scope?.tier === 'string' ? limit.scope.tier : undefined,
      usedFraction: asNumber(limit?.amount?.usedFraction),
      remainingFraction: fractionFromAmount(limit?.amount),
      resetsAt: asNumber(limit?.window?.resetsAt),
      status: typeof limit?.status === 'string' ? limit.status : undefined,
    }));

    return {
      provider,
      credentialKey: `${provider}#${n}`,
      fetchedAt: asNumber(report?.fetchedAt) ?? asNumber(raw?.generatedAt) ?? Date.now(),
      windows,
    };
  });
}

/** Windows keep their key, because `usage.pace` is keyed by the same names. */
function codexBarWindows(usage: any): Array<{ window: any; name: string }> {
  const out: Array<{ window: any; name: string }> = [];
  for (const name of ['primary', 'secondary', 'tertiary']) {
    if (usage?.[name]) out.push({ window: usage[name], name });
  }
  for (const [index, extra] of (usage?.extraRateWindows ?? []).entries()) {
    if (extra?.window) out.push({ window: extra.window, name: String(extra.name ?? `extra${index}`) });
  }
  return out;
}

function parseMoney(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/,/g, '').match(/-?\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function balanceFromUsage(usage: any): { known: boolean; value?: number } {
  // providerCost.balance in non-USD currencies (e.g. Codex "Credits") is not the
  // paid USD wallet that the free-vs-paid routing rule cares about.
  const direct = asNumber(usage?.providerCost?.balance);
  if (direct !== undefined && String(usage?.providerCost?.currencyCode ?? 'USD').toUpperCase() === 'USD') {
    return { known: true, value: direct };
  }

  for (const detail of usage?.details ?? []) {
    if (String(detail?.title ?? '').toLowerCase() !== 'credits') continue;
    for (const row of detail?.rows ?? []) {
      if (String(row?.label ?? '').toLowerCase() === 'remaining') {
        const value = parseMoney(row?.value);
        return value === undefined ? { known: false } : { known: true, value };
      }
    }
  }
  return { known: false };
}

export function normalizeCodexBarProvider(row: any, now = Date.now()): CodexBarUsage {
  const provider = canonicalTelemetryProvider(String(row?.provider ?? 'unknown'));
  if (!row?.usage) {
    return {
      provider,
      telemetryAvailable: false,
      exhausted: false,
      draining: false,
      paidBalanceKnown: false,
      fetchedAt: now,
      reason: typeof row?.error?.message === 'string' ? row.error.message : undefined,
    };
  }

  // A window with a reset time is an allowance that refills on its own (Codex 5h /
  // weekly, Anthropic). A window without one is a prepaid balance that only a manual
  // top-up refills. Kilo's monthly pass is itself a top-up with a bonus, so a spent
  // pass is the normal state while credits remain and must not veto the provider;
  // an empty balance vetoes, but there is no reset date to wait for.
  const windows = codexBarWindows(row.usage)
    .map(({ window: w, name }) => ({
      name,
      usedPercent: asNumber(w?.usedPercent),
      resetsAt: typeof w?.resetsAt === 'string' ? Date.parse(w.resetsAt) : asNumber(w?.resetsAt),
    }))
    .filter((w) => w.usedPercent !== undefined)
    .map((w) => ({
      ...w,
      scope: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? 'allowance' : 'balance',
    }));

  const spent = (w: { usedPercent?: number }) => (w.usedPercent ?? 0) >= 100;
  const balanceWindows = windows.filter((w: any) => w.scope === 'balance');
  const allowanceWindows = windows.filter((w: any) => w.scope === 'allowance');

  // Capacity lives in the balance when the provider exposes one; allowances are then
  // accounting only. With no balance window the allowances are the capacity.
  const vetoing = balanceWindows.length
    ? (balanceWindows.every(spent) ? balanceWindows.filter(spent) : [])
    : allowanceWindows.filter(spent);

  const resetCandidates = vetoing
    .map((w: any) => w.resetsAt)
    .filter((x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > now);

  // A pace forecast answers "will this window last to its reset?", so it is only
  // meaningful for the window that carries capacity — same rule as exhaustion. A
  // spent monthly allowance forecasting badly is accounting, not the provider
  // running dry, while credits remain.
  const capacityScope: 'balance' | 'allowance' = balanceWindows.length ? 'balance' : 'allowance';
  const capacityNames = new Set(
    windows.filter((w: any) => w.scope === capacityScope).map((w: any) => w.name),
  );
  const pace = Object.entries(row?.pace ?? {}) as Array<[string, any]>;
  const drainingNames = pace
    .filter(([name, p]) => p?.willLastToReset === false && capacityNames.has(name))
    .map(([name]) => name);
  const draining = drainingNames.length > 0;
  const balance = balanceFromUsage(row.usage);

  return {
    provider,
    telemetryAvailable: true,
    exhausted: vetoing.length > 0,
    exhaustionScope: vetoing.length ? (balanceWindows.length ? 'balance' : 'allowance') : undefined,
    draining,
    drainingScope: draining ? capacityScope : undefined,
    blockedUntil: resetCandidates.length ? Math.max(...resetCandidates) : undefined,
    paidBalanceUsd: balance.value,
    paidBalanceKnown: balance.known,
    fetchedAt: typeof row?.usage?.updatedAt === 'string' ? Date.parse(row.usage.updatedAt) || now : now,
  };
}

export function parseCodexBarRows(rows: any[]): CodexBarUsage[] {
  return (Array.isArray(rows) ? rows : []).map((row) => normalizeCodexBarProvider(row));
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr?: string;
}

export interface ExecLike {
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult>;
}


export function parseCodexBarCliOutput(result: Pick<ExecResult, 'code' | 'stdout'>): CodexBarUsage[] {
  try {
    const payload = JSON.parse(result.stdout);
    return parseCodexBarRows(payload);
  } catch {
    return [];
  }
}

export async function fetchOmpUsage(exec: ExecLike): Promise<OmpCredentialUsage[]> {
  const result = await exec.exec('omp', ['usage', '--redact', '--json'], { timeout: 90_000 });
  if (result.code !== 0) return [];
  try {
    return normalizeOmpUsage(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

export async function fetchCodexBarUsage(exec: ExecLike): Promise<CodexBarUsage[]> {
  try {
    const res = await fetch('http://127.0.0.1:8080/usage?provider=all', {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return parseCodexBarRows(await res.json() as any[]);
  } catch {
    // Fall through to CLI.
  }

  const result = await exec.exec(
    'codexbar',
    ['usage', '--provider', 'all', '--format', 'json', '--status'],
    { timeout: 30_000 },
  );

  // CodexBar intentionally exits non-zero when one provider fails, while still
  // emitting useful row-level JSON for the healthy providers. Parse stdout
  // regardless of exit status and ignore only malformed/non-JSON output.
  return parseCodexBarCliOutput(result);
}
