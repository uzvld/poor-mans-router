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

function isExhausted(window: UsageWindow, provider: string): boolean {
  if (window.status === 'exhausted') return true;
  // OMP's Codex warning at 100% explicitly means requests remain permitted,
  // potentially on paid credits. Other providers' warning semantics may differ.
  if (provider === 'openai-codex' && window.status === 'warning') return false;
  return typeof window.remainingFraction === 'number' && window.remainingFraction <= 0;
}

function credentialReadyAt(windows: UsageWindow[], now: number, provider: string): number | undefined {
  const exhausted = windows.filter((window) => isExhausted(window, provider));
  if (!exhausted.length) return undefined;
  const resets = exhausted
    .map((w) => w.resetsAt)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > now);
  return resets.length === exhausted.length ? Math.max(...resets) : undefined;
}

function reportQuality(report: OmpCredentialUsage, route: RouteDescriptor, reserveFraction: number, now: number) {
  const windows = relevantWindows(report, route);
  if (!windows.length) return { usable: true, healthy: true, unknown: true };
  const exhausted = windows.some((window) => isExhausted(window, report.provider));
  if (exhausted) return { usable: false, healthy: false, readyAt: credentialReadyAt(windows, now, report.provider), unknown: false };

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

  const drainingRow = matching.find((x) => x.draining);
  if (drainingRow) {
    return {
      state: 'DRAINING',
      freshness: 'FRESH',
      reason: drainingRow.drainingScope === 'balance'
        ? 'CodexBar pace will exhaust the prepaid balance'
        : 'CodexBar pace will not last to reset',
    };
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

// These messages reject continued paid use, not merely an oversized request.
// A bare 402 or "requires more credits" is not evidence of an empty shared wallet.
export function isPaidBalanceError(message: string): boolean {
  return /\badd credits to continue\b|\binsufficient account (?:funds|balance)\b/i.test(message);
}

export function isRateOrQuotaError(message: string): boolean {
  return isPaidBalanceError(message) || /(429|rate.?limit|quota|usage.?limit|too many requests|resource exhausted|credits? exhausted|payment required|insufficient credits?)/i.test(message);
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

// A hard "this model does not exist" rejection is catalog drift (the provider removed or
// renamed the model OMP's own catalog still lists), not a transient rate/quota condition --
// `isRateOrQuotaError` never matches it. Left unclassified it falls through to
// `state.recordFailure`, which only records `lastFailureAt` and never changes
// `evaluateRouteHealth`'s AVAILABLE verdict, so the ladder re-derives and re-announces the
// identical dead route on every fresh process forever (2026-09-19 live incident:
// `docs/investigations/multica-repeated-switch-marker.md`).
export function isPermanentModelError(message: string, modelId?: string): boolean {
  // The quoted model id sits between "model" and the verdict and has no length bound
  // (`bytedance-seed/dola-seed-2.0-pro:free` is 41 chars with quotes; ids get longer).
  // Anthropic's retired-model 404 is `{"error":{"type":"not_found_error","message":"model: <id>"}}`;
  // other not_found_error resources (files, batches) must not cool a model route.
  // OpenCode's 410 ModelDeprecated names the retired id before "has been deprecated".
  // Require that verdict directly after the id, not incidental deprecated request fields.
  if (/model\b[^\n]*?\b(does not exist|not found)|no such model|unknown model|invalid model ?id|not_found_error"[^\n]*?"message"\s*:\s*"model:|\bmodel\s+\S+\s+has been deprecated\b/i.test(message)) return true;
  const verdict = /\b(?:is (?:currently )?unavailable|is no longer available|has been (?:retired|decommissioned))(?=[.!?]|$)/i.exec(message);
  if (!verdict) return false;
  const subject = message.slice(message.lastIndexOf('\n', verdict.index) + 1, verdict.index).trim();
  if (/\bmodel(?:\s+['"`]?[\w./:-]+['"`]?)?$/i.test(subject)) return true;
  if (!modelId) return false;
  // Compare display names and ids without provider-specific family lists:
  // "Claude Sonnet 4.6" and "claude-sonnet-4-6" identify the same failed route.
  const namedModel = subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return namedModel === modelId.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Catalog drift does not heal in minutes: on 2026-09-19 32 of the 52 `kilo/*:free` ids in
// OMP's catalog were absent from Kilo's live gateway, at least 5 of them ranked above the
// first live free route, and Multica gives a turn 4 fresh attempts. With a 15-minute
// cooldown that is one dead turn every 15 minutes, forever. One day matches the state
// store's GC window; a re-added model is picked up again the next day.
const PERMANENT_MODEL_ERROR_COOLDOWN_MS = 24 * 60 * 60_000;

export function cooldownFromPermanentModelError(message: string, now = Date.now(), modelId?: string): LocalRouteState | undefined {
  if (!isPermanentModelError(message, modelId)) return undefined;
  return {
    cooldownUntil: now + PERMANENT_MODEL_ERROR_COOLDOWN_MS,
    lastFailureAt: now,
    reason: message.slice(0, 240),
  };
}

/** Only failed assistant output is provider evidence; successful prose is never a verdict. */
export function providerErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || !('stopReason' in value) || value.stopReason !== 'error') return '';
  const message = 'errorMessage' in value && typeof value.errorMessage === 'string' ? value.errorMessage : '';
  const modelId = 'model' in value && typeof value.model === 'string' ? value.model : undefined;
  if (!('content' in value) || !Array.isArray(value.content)) return message;
  const partial = value.content
    .filter((block): block is { type: 'text'; text: string } => !!block && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('');
  const subject = partial.split(/\s+(?:is|has)\b/i, 1)[0].replace(/^model\s+/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const identifiesFailedModel = modelId !== undefined
    && subject === modelId.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return identifiesFailedModel && isPermanentModelError(partial, modelId) ? `${message}\n${partial}` : message;
}

const CREDENTIAL_REJECTION = /\b(?:API key|access token|credential)\b[^\n]*\b(?:expired|invalid|revoked)\b|api_key_expired/i;

/** An explicit provider statement that the presented credential is expired, invalid or revoked. */
export function isCredentialRejection(message: string): boolean {
  return CREDENTIAL_REJECTION.test(message);
}

/** Recognized route failures only; request-shape and native-turn protocol errors need their own repair. */
export function cooldownFromProviderError(message: string, now = Date.now(), modelId?: string): LocalRouteState | undefined {
  const known = cooldownFromPermanentModelError(message, now, modelId) ?? cooldownFromRetry(message, undefined, now);
  if (known) return known;
  if (!isCredentialRejection(message) && !/stream ended without a finish reason|socket connection was closed unexpectedly|connection (?:reset|refused)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|request timed out/i.test(message)) return undefined;
  return { cooldownUntil: now + 5 * 60_000, lastFailureAt: now, reason: message.slice(0, 240) };
}
