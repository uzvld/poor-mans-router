import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalRouteState } from './health.ts';
import { mergeIntelCache, type IntelCache } from './openrouter-intel.ts';

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

function isIntelCache(value: unknown): value is IntelCache {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>; // shape checked field by field below
  return typeof v.fetchedAt === 'number' && typeof v.lastAttemptAt === 'number'
    && !!v.data && typeof v.data === 'object'
    && (v.blockedUntil === undefined || typeof v.blockedUntil === 'number');
}

/**
 * The OpenRouter Data API snapshot and its rate-limit block, shared by every OMP process on the
 * machine: the budget (500 requests/day) belongs to the account, not the process.
 *
 * Kept out of `state.json` on purpose. A long-lived `omp --mode rpc-ui` process keeps the code it
 * started with and rewrites `state.json` with only the fields that code knows (install.sh warns
 * about it), so an intel field there was erased within minutes of the 2026-10-09 install. This
 * file is written by intel-aware code only.
 */
export class IntelStore {
  constructor(private readonly filename: string) {}

  /** The sibling of a state file: `state.json` → `state.intel.json`. */
  static besideStateFile(stateFile: string): IntelStore {
    return new IntelStore(`${stateFile.replace(/\.json$/, '')}.intel.json`);
  }

  read(): IntelCache | undefined {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      return isIntelCache(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** Merge with what a peer wrote since (newer snapshot, latest attempt, latest block) and replace atomically. */
  save(cache: IntelCache): IntelCache {
    const disk = this.read();
    const merged = disk ? mergeIntelCache(cache, disk) : cache;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, this.filename);
    return merged;
  }
}

function stampOf(state: StoredRouteState): number {
  return state.updatedAt ?? state.lastFailureAt ?? state.lastSuccessAt ?? 0;
}

export class RouterStateStore {
  private routes: Record<string, StoredRouteState> = {};
  private telemetrySnapshot: (TelemetrySnapshot & { fetchedAt: number }) | undefined;
  private readonly filename: string;
  // Remembered so `save()` can re-apply the sweep after merging: a key this process already
  // collected must not be resurrected from a peer's older on-disk copy.
  private gc: { currentRoutes: Set<string>; maxAgeMs: number } | undefined;

  constructor(filename: string) {
    this.filename = filename;
  }

  private read(): PersistedState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      const routes = raw && typeof raw.routes === 'object' && raw.routes ? raw.routes : {};
      const cached = raw?.telemetry;
      const telemetry = cached && typeof cached.fetchedAt === 'number'
        && Array.isArray(cached.ompReports) && Array.isArray(cached.codexbar)
        ? cached
        : undefined;
      return telemetry ? { routes, telemetry } : { routes };
    } catch {
      return { routes: {} };
    }
  }

  load(): void {
    const disk = this.read();
    this.routes = disk.routes;
    this.telemetrySnapshot = disk.telemetry;
  }

  /**
   * Every OMP process on the machine shares this file -- the fresh one Multica spawns per
   * attempt and any long-lived interactive session -- and each loaded it once at
   * session_start. Writing the in-memory map back verbatim lets the stalest process erase
   * whatever its peers recorded since (a cooldown, most damagingly). Merge per route
   * instead, newest record wins; same for the telemetry snapshot.
   */
  save(): void {
    const disk = this.read();
    for (const [key, theirs] of Object.entries(disk.routes)) {
      const ours = this.routes[key];
      if (!ours || stampOf(theirs) > stampOf(ours)) this.routes[key] = theirs;
    }
    if (disk.telemetry && (!this.telemetrySnapshot || disk.telemetry.fetchedAt > this.telemetrySnapshot.fetchedAt)) {
      this.telemetrySnapshot = disk.telemetry;
    }
    if (this.gc) this.sweep(this.gc.currentRoutes, Date.now(), this.gc.maxAgeMs);

    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    // Multiple OMP processes share this file. A fixed `.tmp` lets one process rename another
    // process's temp file and makes the loser throw ENOENT, dropping fresh telemetry entirely.
    // Unique temp names preserve atomic rename while allowing concurrent writers to merge the
    // current on-disk snapshot independently.
    const tmp = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
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
    this.gc = { currentRoutes, maxAgeMs };
    this.sweep(currentRoutes, now, maxAgeMs);
  }

  private sweep(currentRoutes: Set<string>, now: number, maxAgeMs: number): void {
    for (const [key, state] of Object.entries(this.routes)) {
      if (currentRoutes.has(key)) continue;
      if (now - stampOf(state) > maxAgeMs) delete this.routes[key];
    }
  }
}
