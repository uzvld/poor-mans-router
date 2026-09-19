import type { RouteHealth } from './types.ts';
import type { CodexBarUsage, OmpCredentialUsage, UsageWindow } from './telemetry.ts';

export interface LocalRouteState {
  cooldownUntil?: number;
  reason?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface RouteDescriptor {
  provider: string;
  modelId: string;
  free: boolean;
}

export interface HealthInputs {
  ompReports: OmpCredentialUsage[];
  codexbar: CodexBarUsage[];
  local?: LocalRouteState;
  reservePct: number;
  now: number;
}

function modelTier(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  if (id.includes('fable')) return 'fable';
  return undefined;
}

function relevantWindows(report: OmpCredentialUsage, route: RouteDescriptor): UsageWindow[] {
  const tier = modelTier(route.modelId);
  return report.windows.filter((window) => {
    if (window.shared) return true;
    if (window.tier) return !!tier && window.tier.toLowerCase() === tier;
    return true;
  });
}

function isExhausted(window: UsageWindow): boolean {
  if (window.status === 'exhausted') return true;
  return typeof window.remainingFraction === 'number' && window.remainingFraction <= 0;
}

function credentialReadyAt(windows: UsageWindow[], now: number): number | undefined {
  const exhausted = windows.filter(isExhausted);
  if (!exhausted.length) return undefined;
  const resets = exhausted
    .map((w) => w.resetsAt)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > now);
  return resets.length === exhausted.length ? Math.max(...resets) : undefined;
}

function reportQuality(report: OmpCredentialUsage, route: RouteDescriptor, reserveFraction: number, now: number) {
  const windows = relevantWindows(report, route);
  if (!windows.length) return { usable: true, healthy: true, unknown: true };
  const exhausted = windows.some(isExhausted);
  if (exhausted) return { usable: false, healthy: false, readyAt: credentialReadyAt(windows, now), unknown: false };

  const knownRemaining = windows
    .map((w) => w.remainingFraction)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const healthy = knownRemaining.length === 0 || knownRemaining.every((x) => x > reserveFraction);
  return { usable: true, healthy, unknown: knownRemaining.length === 0 };
}

function matchingCodexBar(provider: string, rows: CodexBarUsage[]): CodexBarUsage[] {
  return rows.filter((row) => row.provider === provider && row.telemetryAvailable);
}

function combineCodexBar(route: RouteDescriptor, rows: CodexBarUsage[], now: number, respectPaidBalance = true): RouteHealth | undefined {
  const matching = matchingCodexBar(route.provider, rows);
  if (!matching.length) return undefined;

  // Free routes on paid aggregators are not blocked merely because the paid wallet/pass is empty.
  const walletIndependentFree = route.free && (route.provider === 'openrouter' || route.provider === 'kilo');
  if (respectPaidBalance && !route.free) {
    const balances = matching.filter((x) => x.paidBalanceKnown).map((x) => x.paidBalanceUsd ?? 0);
    if (balances.length && balances.every((balance) => balance <= 0)) {
      return { state: 'COOLDOWN', freshness: 'FRESH', reason: 'paid balance exhausted' };
    }
  }

  if (!walletIndependentFree) {
    const usable = matching.filter((x) => !x.exhausted);
    if (!usable.length && matching.some((x) => x.exhausted)) {
      const resets = matching
        .map((x) => x.blockedUntil)
        .filter((x): x is number => typeof x === 'number' && x > now);
      // A spent prepaid balance clears on a manual top-up, not on an allowance reset,
      // so it must not borrow another window's date.
      const balanceExhausted = matching.some((x) => x.exhausted && x.exhaustionScope === 'balance');
      return {
        state: 'COOLDOWN',
        freshness: 'FRESH',
        cooldownUntil: resets.length ? Math.min(...resets) : undefined,
        reason: balanceExhausted ? 'CodexBar prepaid balance exhausted' : 'CodexBar quota exhausted',
      };
    }
  }

  if (matching.some((x) => x.draining)) {
    return { state: 'DRAINING', freshness: 'FRESH', reason: 'CodexBar pace will not last to reset' };
  }
  return { state: 'AVAILABLE', freshness: 'FRESH' };
}

export function evaluateRouteHealth(route: RouteDescriptor, input: HealthInputs): RouteHealth {
  const local = input.local;
  if (local?.cooldownUntil && local.cooldownUntil > input.now) {
    return {
      state: 'COOLDOWN',
      freshness: 'FRESH',
      cooldownUntil: local.cooldownUntil,
      reason: local.reason ?? 'runtime cooldown',
      lastSuccessAt: local.lastSuccessAt,
      lastFailureAt: local.lastFailureAt,
    };
  }

  const providerReports = input.ompReports.filter((r) => r.provider === route.provider);
  if (providerReports.length) {
    const reserve = input.reservePct / 100;
    const results = providerReports.map((report) => reportQuality(report, route, reserve, input.now));
    const usable = results.filter((r) => r.usable);

    if (!usable.length) {
      const ready = results
        .map((r) => r.readyAt)
        .filter((x): x is number => typeof x === 'number' && x > input.now);
      return {
        state: 'COOLDOWN',
        freshness: 'FRESH',
        cooldownUntil: ready.length ? Math.min(...ready) : undefined,
        reason: 'OMP quota exhausted across credentials',
        lastSuccessAt: local?.lastSuccessAt,
        lastFailureAt: local?.lastFailureAt,
      };
    }

    // OMP scoped quota/capacity is authoritative for route health whenever a fresh
    // OMP report exists for this provider. CodexBar `pace.*.willLastToReset` is a
    // burn-rate FORECAST, not a capacity measurement: it must not convert a route
    // that OMP reports as healthy into DRAINING. Pace still reaches the pressure
    // signal via the selected route's DRAINING state when OMP itself is near reserve,
    // and remains the health source on the no-OMP path below.
    if (usable.some((r) => r.healthy)) {
      return {
        state: 'AVAILABLE',
        freshness: results.some((r) => r.unknown) ? 'UNKNOWN' : 'FRESH',
        lastSuccessAt: local?.lastSuccessAt,
        lastFailureAt: local?.lastFailureAt,
      };
    }

    return {
      state: 'DRAINING',
      freshness: 'FRESH',
      reason: `OMP quota within ${input.reservePct}% reserve`,
      lastSuccessAt: local?.lastSuccessAt,
      lastFailureAt: local?.lastFailureAt,
    };
  }

  const codex = combineCodexBar(route, input.codexbar, input.now);
  if (codex) return { ...codex, lastSuccessAt: local?.lastSuccessAt, lastFailureAt: local?.lastFailureAt };

  return {
    state: 'AVAILABLE',
    freshness: 'UNKNOWN',
    reason: 'no live quota telemetry',
    lastSuccessAt: local?.lastSuccessAt,
    lastFailureAt: local?.lastFailureAt,
  };
}

export function isRateOrQuotaError(message: string): boolean {
  return /(429|rate.?limit|quota|usage.?limit|too many requests|resource exhausted|credits? exhausted)/i.test(message);
}

function retryHintMs(message: string): number | undefined {
  const match = message.match(/(?:retry\s*[- ]?after|try\s+again\s+in|reset\s+in)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] ?? 's').toLowerCase();
  if (unit.startsWith('ms')) return value;
  if (unit === 'm' || unit.startsWith('min')) return value * 60_000;
  if (unit === 'h' || unit.startsWith('hour')) return value * 60 * 60_000;
  return value * 1000;
}

export function cooldownFromRetry(message: string, delayMs: number | undefined, now = Date.now()): LocalRouteState | undefined {
  if (!isRateOrQuotaError(message)) return undefined;
  const hinted = retryHintMs(message) ?? 0;
  const eventDelay = typeof delayMs === 'number' && delayMs > 0 ? delayMs : 0;
  const cooldownMs = Math.max(hinted, eventDelay, hinted || eventDelay ? 0 : 5 * 60_000);
  return {
    cooldownUntil: now + cooldownMs,
    lastFailureAt: now,
    reason: message.slice(0, 240),
  };
}
