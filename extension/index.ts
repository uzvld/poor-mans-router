import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouterPolicy, Tier } from './types.ts';
import { DEFAULT_POLICY, normalizePolicy } from './policy.ts';
import { fetchCodexBarUsage, fetchOmpUsage, type CodexBarUsage, type OmpCredentialUsage } from './telemetry.ts';
import { fetchOmpHistory, type HistoryMap } from './history.ts';
import {
  EMPTY_INTEL_CACHE,
  refreshOpenRouterIntel,
  type IntelCache,
} from './openrouter-intel.ts';
import { buildRoutes, selectForTier, type SelectionResult } from './ranking.ts';
import { cooldownFromRetry, isRateOrQuotaError } from './health.ts';
import { RouterStateStore } from './state.ts';
import {
  FreeProbeGate,
  allowDrainingForTier,
  pressureForSelection,
  pressureMessage,
  switchMarker,
  normalizeRuntimeSelector,
  shouldRouteBeforeAgentStart,
  retryRoutingPolicy,
} from './runtime.ts';
import { formatRouteStatus } from './status.ts';
import { VIRTUAL_PROVIDER, registerVirtualRouterProvider, resolveModeTransition, type ManagedMode, type RoutingMode } from './virtual-model.ts';

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(EXTENSION_DIR, 'state.json');
const POLICY_FILE = join(EXTENSION_DIR, 'policy.yml');
const LIVE_TTL_MS = 2 * 60_000;
const LIVE_STALE_IF_ERROR_MS = 5 * 60_000;
const HISTORY_TTL_MS = 5 * 60_000;

type Timestamped<T> = { value: T; fetchedAt: number };

async function loadPolicy(): Promise<RouterPolicy> {
  const bun = (globalThis as any).Bun;
  if (!bun?.file || !bun?.YAML?.parse) return DEFAULT_POLICY;
  try {
    const text = await bun.file(POLICY_FILE).text();
    return normalizePolicy(bun.YAML.parse(text));
  } catch {
    return DEFAULT_POLICY;
  }
}

function modelKey(model: any): string | undefined {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

function asModelLike(model: any) {
  return {
    provider: String(model.provider),
    id: String(model.id),
    selector: `${model.provider}/${model.id}`,
    name: typeof model.name === 'string' ? model.name : undefined,
    cost: model.cost ?? {},
  };
}

function sortStatusRoutes(routes: any[], selected?: string) {
  const stateRank: Record<string, number> = { COOLDOWN: 0, DRAINING: 1, AVAILABLE: 2 };
  return [...routes].sort((a, b) => {
    if (a.key === selected) return -1;
    if (b.key === selected) return 1;
    const rank = (stateRank[a.health.state] ?? 9) - (stateRank[b.health.state] ?? 9);
    return rank || a.key.localeCompare(b.key);
  });
}

export default function adaptiveRouter(pi: ExtensionAPI) {
  pi.setLabel('Adaptive Model Router');
  registerVirtualRouterProvider(pi);

  const logger: any = (pi as any).logger ?? { info() {}, warn() {}, debug() {} };
  const state = new RouterStateStore(STATE_FILE);
  const probeGate = new FreeProbeGate();

  let policy: RouterPolicy = DEFAULT_POLICY;
  let ompUsage: Timestamped<OmpCredentialUsage[]> = { value: [], fetchedAt: 0 };
  let codexbar: Timestamped<CodexBarUsage[]> = { value: [], fetchedAt: 0 };
  let history: Timestamped<HistoryMap> = { value: {}, fetchedAt: 0 };
  let intel: IntelCache = { ...EMPTY_INTEL_CACHE };
  let liveRefresh: Promise<void> | undefined;
  let historyRefresh: Promise<void> | undefined;
  let lastRoutedSelector: string | undefined;
  let routingMode: RoutingMode = 'manual';
  let lastRouterSelected: string | undefined;
  let retryActive = false;
  let nativeFallbackAppliedForRetry = false;
  let lastDecision: {
    tier: Tier;
    selection?: SelectionResult;
    routes: any[];
    at: number;
  } | undefined;

  const refreshLive = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - Math.max(ompUsage.fetchedAt, codexbar.fetchedAt) < LIVE_TTL_MS) return;
    if (liveRefresh) return liveRefresh;

    liveRefresh = (async () => {
      const [ompResult, cbResult] = await Promise.allSettled([
        fetchOmpUsage(pi as any),
        fetchCodexBarUsage(pi as any),
      ]);
      const fetchedAt = Date.now();

      if (ompResult.status === 'fulfilled' && ompResult.value.length) {
        ompUsage = { value: ompResult.value, fetchedAt };
      } else if (fetchedAt - ompUsage.fetchedAt > LIVE_STALE_IF_ERROR_MS) {
        ompUsage = { value: [], fetchedAt: 0 };
      }

      if (cbResult.status === 'fulfilled' && cbResult.value.length) {
        codexbar = { value: cbResult.value, fetchedAt };
      } else if (fetchedAt - codexbar.fetchedAt > LIVE_STALE_IF_ERROR_MS) {
        codexbar = { value: [], fetchedAt: 0 };
      }
    })().catch((error) => {
      logger.warn('adaptive-router live telemetry refresh failed', { error: String(error) });
    }).finally(() => {
      liveRefresh = undefined;
    });

    return liveRefresh;
  };

  const refreshHistory = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - history.fetchedAt < HISTORY_TTL_MS) return;
    if (historyRefresh) return historyRefresh;
    historyRefresh = fetchOmpHistory(pi as any)
      .then((value) => {
        if (Object.keys(value).length) history = { value, fetchedAt: Date.now() };
      })
      .catch((error) => logger.warn('adaptive-router stats refresh failed', { error: String(error) }))
      .finally(() => { historyRefresh = undefined; });
    return historyRefresh;
  };

  const refreshIntel = async (ctx: any): Promise<void> => {
    try {
      intel = await refreshOpenRouterIntel(ctx, intel);
    } catch (error) {
      logger.warn('adaptive-router OpenRouter intelligence refresh failed', { error: String(error) });
    }
  };

  const currentRoutes = (ctx: any) => {
    state.clearExpired();
    const models = ctx.models.list().map(asModelLike);
    return buildRoutes(models, {
      ompReports: ompUsage.value,
      codexbar: codexbar.value,
      localState: state.snapshot(),
      history: history.value,
      intel: intel.data,
      reservePct: 10,
      now: Date.now(),
    });
  };

  const chooseForCurrentWork = (ctx: any, mode: ManagedMode) => {
    const routes = currentRoutes(ctx);
    const selection = selectForTier(
      routes,
      policy.tiers[mode].classes,
      {
        allowDraining: allowDrainingForTier(mode),
        preference: mode === 'small' ? 'speed' : 'quality',
        // Same-family affinity for the model the session is already on (scoped tie-break only).
        currentKey: modelKey(ctx.models.current()),
      },
    );
    lastDecision = { tier: mode, selection, routes, at: Date.now() };
    return { routes, selection };
  };

  pi.on('session_start', async (_event: any, ctx: any) => {
    policy = await loadPolicy();
    state.load();
    const keys = new Set(ctx.models.list().map(modelKey).filter((x: string | undefined): x is string => !!x));
    state.garbageCollect(keys);
    state.save();

    // Do not stall session startup on optional telemetry; managed timers contain callback failures.
    ctx.setTimeout(async () => {
      await Promise.allSettled([refreshLive(true), refreshHistory(true), refreshIntel(ctx)]);
    }, 0);
    ctx.setInterval(() => refreshLive(false), LIVE_TTL_MS);
    ctx.setInterval(() => refreshHistory(false), HISTORY_TTL_MS);
    ctx.setInterval(() => refreshIntel(ctx), 15 * 60_000);

    logger.info('adaptive-router started', { models: ctx.models.list().length });
  });

  // A successful router switch is announced in the transcript; a host without a UI
  // surface (or a notify that throws) must never turn a routing decision into a failed turn.
  function announceSwitch(ctx: any, from: string, to: string, reason?: string): void {
    try {
      ctx.ui?.notify?.(switchMarker(from, to, reason), 'info');
    } catch (error) {
      logger.warn('adaptive-router could not announce model switch', { error: String(error) });
    }
  }

  pi.on('before_agent_start', async (_event: any, ctx: any) => {
    const currentKey = modelKey(ctx.models.current());
    const previousMode = routingMode;
    routingMode = resolveModeTransition(previousMode, currentKey, lastRouterSelected);
    if (previousMode !== 'manual' && routingMode === 'manual') {
      logger.info('adaptive-router opt-out: manual model selection', { currentKey });
    }
    if (routingMode === 'manual') return undefined;
    if (!shouldRouteBeforeAgentStart(retryActive)) return undefined;
    try {
      await refreshLive(false);
      // History and public intelligence are ranking hints; they never block new work.
      ctx.setTimeout(() => refreshHistory(false), 0);
      ctx.setTimeout(() => refreshIntel(ctx), 0);

      const { selection } = chooseForCurrentWork(ctx, routingMode === 'manual' ? 'balanced' : routingMode);
      if (selection) {
        const target = ctx.models.resolve(selection.route.selector);
        if (target && currentKey !== selection.route.key) {
          const changed = await pi.setModel(target);
          if (!changed) {
            logger.warn('adaptive-router could not switch model', { selector: selection.route.selector });
            // A failed switch must not claim the target: the next turn retries.
            lastRouterSelected = undefined;
          } else {
            announceSwitch(ctx, currentKey, selection.route.key, selection.reason);
            lastRouterSelected = selection.route.key;
          }
        }
        lastRoutedSelector = selection.route.key;
      }

      const pressure = pressureForSelection(selection);
      const content = pressureMessage(pressure);
      if (content) {
        return {
          message: {
            customType: 'adaptive-router.resource-pressure',
            content,
            display: false,
            details: { pressure },
          },
        };
      }
    } catch (error) {
      logger.warn('adaptive-router selection failed open', { error: String(error) });
      return undefined;
    }
    return undefined;
  });

  // Fail-closed seatbelt (spec §4): the virtual provider's baseUrl is the discard
  // port, so a request issued while the session is still on a router/* model would
  // burn OMP's 10 silent auto-retries on a connection error. Abort the turn instead.
  // Detection uses the session's current model, not the payload's bare model id: a
  // real provider may legitimately ship a model called "balanced".
  (pi as any).on('before_provider_request', async (_event: any, ctx: any) => {
    if (ctx?.models?.current?.()?.provider !== VIRTUAL_PROVIDER) return undefined;
    try {
      ctx.abort?.();
    } catch (error) {
      logger.warn('adaptive-router guard could not abort the turn', { error: String(error) });
    }
    try {
      ctx.ui?.notify?.(
        'adaptive-router: virtual router model leaked to provider transport — this is a router bug; select a concrete model with /model',
        'error',
      );
    } catch (error) {
      logger.warn('adaptive-router guard could not announce the leak', { error: String(error) });
    }
    return undefined;
  });

  (pi as any).on('retry_fallback_applied', async (event: any) => {
    nativeFallbackAppliedForRetry = true;
    if (typeof event?.from === 'string') lastRetryFrom = normalizeRuntimeSelector(event.from);
    if (typeof event?.to === 'string') lastRoutedSelector = normalizeRuntimeSelector(event.to);
  });

  pi.on('auto_retry_start', async (event: any, ctx: any) => {
    retryActive = true;
    const message = String(event?.errorMessage ?? '');
    const rateOrQuota = isRateOrQuotaError(message);
    const retryDecision = retryRoutingPolicy(
      rateOrQuota,
      typeof event?.delayMs === 'number' ? event.delayMs : undefined,
      nativeFallbackAppliedForRetry,
    );
    nativeFallbackAppliedForRetry = false;

    const routeKey = lastRetryFrom ?? lastRoutedSelector ?? modelKey(ctx.models.current());
    lastRetryFrom = undefined;
    if (!routeKey) return;

    if (retryDecision.markRouteCooldown) {
      const cooldown = cooldownFromRetry(message, event?.delayMs, Date.now());
      if (cooldown?.cooldownUntil) {
        state.markCooldown(routeKey, cooldown.cooldownUntil, cooldown.reason ?? 'rate/quota retry', cooldown.lastFailureAt);
      } else {
        state.recordFailure(routeKey);
      }
    } else {
      // Zero-delay quota retries are usually OMP switching credentials inside the
      // same provider. Record the failed attempt but keep the route eligible.
      state.recordFailure(routeKey);
    }
    state.save();

    if (retryDecision.markRouteCooldown && rateOrQuota && lastDecision) {
      const failedRoute = lastDecision.routes.find((route) => route.key === routeKey);
      if (failedRoute?.free) {
        const alternates = probeGate.candidates(routeKey, lastDecision.routes, Date.now());
        if (alternates.length) {
          // Current OMP has no public out-of-band completion API. A v1 "probe" refreshes
          // live quota/catalog metadata in the background; the next real lightweight task
          // is the proof of model availability. No foreground inference request is burned.
          ctx.setTimeout(async () => {
            await refreshLive(true);
            logger.debug('adaptive-router refreshed alternate free routes', {
              alternates: alternates.map((route) => route.key),
            });
          }, 0);
        }
      }
    }
  });

  pi.on('auto_retry_end', async () => {
    retryActive = false;
    nativeFallbackAppliedForRetry = false;
    lastRetryFrom = undefined;
  });

  pi.on('agent_end', async (_event: any, ctx: any) => {
    const key = modelKey(ctx.models.current()) ?? lastRoutedSelector;
    if (!key) return;
    state.recordSuccess(key);
    state.save();
  });

  pi.registerCommand('route-status', {
    description: 'Show adaptive model routing state',
    handler: async (_args: string, ctx: any) => {
      if (!lastDecision) {
        ctx.ui.notify('adaptive-router: no routing decision yet', 'info');
        return;
      }
      const now = Date.now();
      const selected = lastDecision.selection?.route.key;
      const text = formatRouteStatus({
        tier: lastDecision.tier,
        selected,
        reason: lastDecision.selection?.reason,
        routes: sortStatusRoutes(lastDecision.routes, selected),
        sources: {
          ompUsageAgeMs: ompUsage.fetchedAt ? now - ompUsage.fetchedAt : undefined,
          codexBarAgeMs: codexbar.fetchedAt ? now - codexbar.fetchedAt : undefined,
          openRouterIntelAgeMs: intel.fetchedAt ? now - intel.fetchedAt : undefined,
          historyAgeMs: history.fetchedAt ? now - history.fetchedAt : undefined,
        },
      });
      ctx.ui.notify(text, 'info');
    },
  });
}
