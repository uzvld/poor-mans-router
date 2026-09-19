import fs from 'node:fs';
import path from 'node:path';
import type { LocalRouteState } from './health.ts';

interface StoredRouteState extends LocalRouteState {
  updatedAt?: number;
}

/**
 * Telemetry is cached on disk because Multica spawns a fresh OMP process per run:
 * an in-memory cache is always cold there, and the first turn must not wait for
 * `omp usage` plus the CodexBar CLI (~30 s observed) before routing.
 */
export interface TelemetrySnapshot {
  ompReports: unknown[];
  codexbar: unknown[];
}

interface PersistedState {
  routes: Record<string, StoredRouteState>;
  telemetry?: TelemetrySnapshot & { fetchedAt: number };
}

export class RouterStateStore {
  private routes: Record<string, StoredRouteState> = {};
  private telemetrySnapshot: (TelemetrySnapshot & { fetchedAt: number }) | undefined;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      this.routes = raw && typeof raw.routes === 'object' && raw.routes ? raw.routes : {};
      const cached = raw?.telemetry;
      this.telemetrySnapshot = cached && typeof cached.fetchedAt === 'number'
        && Array.isArray(cached.ompReports) && Array.isArray(cached.codexbar)
        ? cached
        : undefined;
    } catch {
      this.routes = {};
      this.telemetrySnapshot = undefined;
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.tmp`;
    const state: PersistedState = { routes: this.routes };
    if (this.telemetrySnapshot) state.telemetry = this.telemetrySnapshot;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.filename);
  }

  saveTelemetry(snapshot: TelemetrySnapshot, now = Date.now()): void {
    this.telemetrySnapshot = { ompReports: snapshot.ompReports, codexbar: snapshot.codexbar, fetchedAt: now };
  }

  /** Last-known telemetry with its original age, or `undefined` once too old to act on. */
  telemetry(now = Date.now(), maxAgeMs = 15 * 60_000): (TelemetrySnapshot & { fetchedAt: number }) | undefined {
    const cached = this.telemetrySnapshot;
    if (!cached || now - cached.fetchedAt > maxAgeMs) return undefined;
    return { ompReports: cached.ompReports, codexbar: cached.codexbar, fetchedAt: cached.fetchedAt };
  }

  get(routeKey: string): StoredRouteState | undefined {
    return this.routes[routeKey];
  }

  snapshot(): Record<string, StoredRouteState> {
    return { ...this.routes };
  }

  markCooldown(routeKey: string, cooldownUntil: number, reason: string, now = Date.now()): void {
    const current = this.routes[routeKey] ?? {};
    this.routes[routeKey] = {
      ...current,
      cooldownUntil,
      reason: reason.slice(0, 240),
      lastFailureAt: now,
      updatedAt: now,
    };
  }

  recordFailure(routeKey: string, now = Date.now()): void {
    const current = this.routes[routeKey] ?? {};
    this.routes[routeKey] = { ...current, lastFailureAt: now, updatedAt: now };
  }

  recordSuccess(routeKey: string, now = Date.now()): void {
    const current = this.routes[routeKey] ?? {};
    this.routes[routeKey] = { ...current, lastSuccessAt: now, updatedAt: now };
  }

  clearExpired(now = Date.now()): void {
    for (const [key, state] of Object.entries(this.routes)) {
      if (state.cooldownUntil && state.cooldownUntil <= now) {
        const { cooldownUntil: _c, reason: _r, ...rest } = state;
        this.routes[key] = { ...rest, updatedAt: now };
      }
    }
  }

  garbageCollect(currentRoutes: Set<string>, now = Date.now(), maxAgeMs = 24 * 60 * 60_000): void {
    for (const [key, state] of Object.entries(this.routes)) {
      if (currentRoutes.has(key)) continue;
      const updatedAt = state.updatedAt ?? state.lastFailureAt ?? state.lastSuccessAt ?? 0;
      if (now - updatedAt > maxAgeMs) delete this.routes[key];
    }
  }
}
