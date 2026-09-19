import fs from 'node:fs';
import path from 'node:path';
import type { LocalRouteState } from './health.ts';

interface StoredRouteState extends LocalRouteState {
  updatedAt?: number;
}

interface PersistedState {
  routes: Record<string, StoredRouteState>;
}

export class RouterStateStore {
  private routes: Record<string, StoredRouteState> = {};
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      this.routes = raw && typeof raw.routes === 'object' && raw.routes ? raw.routes : {};
    } catch {
      this.routes = {};
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ routes: this.routes } satisfies PersistedState, null, 2));
    fs.renameSync(tmp, this.filename);
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
