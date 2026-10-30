import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IntelStore } from './state.ts';
import { BENCH_SOURCES, type BenchObservation, type BenchRow, type BenchSnapshot, type BenchSource, type Effort, type Facet } from './bench-types.ts';
import { isFiniteNumber, isRecord } from './bench-util.ts';

export const BENCH_TTL_MS = 24 * 3_600_000;
export const BENCH_RETRY_FLOOR_MS = 15 * 60_000;
/** Snapshots kept per source: a month of daily refreshes is what the nerf trend and the re-baseline check read. */
const RETENTION = 30;

const FACETS: readonly string[] = ['coding', 'agentic', 'general'];
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Per source, oldest first. */
export type BenchHistory = Partial<Record<BenchSource, BenchSnapshot[]>>;

export interface BenchState {
  history: BenchHistory;
  /** Last fetch attempt per source, successful or not: the retry floor counts from it. */
  attempts: Partial<Record<BenchSource, number>>;
}

function observationOf(value: unknown): BenchObservation | undefined {
  if (!isRecord(value) || typeof value.facet !== 'string' || !FACETS.includes(value.facet)) return undefined;
  if (!isFiniteNumber(value.value) || !isFiniteNumber(value.confidence) || typeof value.label !== 'string') return undefined;
  const effort = typeof value.effort === 'string' && EFFORTS.includes(value.effort) ? (value.effort as Effort) : undefined;
  return {
    facet: value.facet as Facet,
    value: value.value,
    confidence: value.confidence,
    label: value.label,
    ...(effort ? { effort } : {}),
    ...(isFiniteNumber(value.ci) ? { ci: value.ci } : {}),
  };
}

function rowOf(value: unknown): BenchRow | undefined {
  if (!isRecord(value) || typeof value.model !== 'string' || !Array.isArray(value.observations)) return undefined;
  const observations = value.observations.map(observationOf).filter((o): o is BenchObservation => o !== undefined);
  return observations.length > 0 ? { model: value.model, observations } : undefined;
}

/**
 * A snapshot read from disk or handed in, or undefined when it cannot be trusted: wrong source,
 * a time in the future (it would read as "just now" forever), or no usable row left. Damaged rows
 * and observations are dropped one by one.
 */
function snapshotOf(value: unknown, source: BenchSource, now: number): BenchSnapshot | undefined {
  if (!isRecord(value) || value.source !== source || !isFiniteNumber(value.fetchedAt) || value.fetchedAt > now) return undefined;
  if (typeof value.sourceVersion !== 'string' || !Array.isArray(value.rows)) return undefined;
  const rows = value.rows.map(rowOf).filter((r): r is BenchRow => r !== undefined);
  if (rows.length === 0) return undefined;
  return {
    source,
    fetchedAt: value.fetchedAt,
    sourceVersion: value.sourceVersion,
    ...(typeof value.publishedAt === 'string' ? { publishedAt: value.publishedAt } : {}),
    rows,
  };
}

/** Oldest first, one snapshot per `fetchedAt` (the later one wins), the newest `RETENTION` kept. */
function retained(snapshots: BenchSnapshot[]): BenchSnapshot[] {
  const byTime = new Map<number, BenchSnapshot>();
  for (const snapshot of snapshots) byTime.set(snapshot.fetchedAt, snapshot);
  return [...byTime.values()].sort((a, b) => a.fetchedAt - b.fetchedAt).slice(-RETENTION);
}

/**
 * The dated snapshots of every benchmark source, shared by every OMP process on the machine. Its own
 * file, like the intel cache and for the same reason: a long-lived process that rewrites `state.json`
 * with the fields its older code knows must not erase it. Written by benchmark-aware code only.
 */
export class BenchStore {
  constructor(readonly filename: string) {}

  /** The sibling of a state file: `state.json` → `state.bench.json`. */
  static besideStateFile(stateFile: string): BenchStore {
    return new BenchStore(`${stateFile.replace(/\.json$/, '')}.bench.json`);
  }

  /** Whatever can be trusted on disk; a missing, corrupted or hand-edited file reads as empty. */
  read(now = Date.now()): BenchState {
    const state: BenchState = { history: {}, attempts: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    } catch {
      return state;
    }
    if (!isRecord(raw)) return state;

    for (const source of BENCH_SOURCES) {
      const stored = isRecord(raw.history) ? raw.history[source] : undefined;
      if (Array.isArray(stored)) {
        const snapshots = retained(stored.map((entry) => snapshotOf(entry, source, now)).filter((s): s is BenchSnapshot => s !== undefined));
        if (snapshots.length > 0) state.history[source] = snapshots;
      }
      const attempt = isRecord(raw.attempts) ? raw.attempts[source] : undefined;
      if (isFiniteNumber(attempt) && attempt <= now) state.attempts[source] = attempt;
    }
    return state;
  }

  /**
   * Add one snapshot to its source's history. Refuses one with no usable row: a source that answers
   * 200 with nothing must leave the last good snapshot in place. Merges with what a peer wrote since,
   * and replaces the file atomically.
   */
  append(snapshot: BenchSnapshot, now = Date.now()): BenchHistory {
    const valid = snapshotOf(snapshot, snapshot.source, now);
    if (!valid) throw new Error(`refusing an empty or invalid ${snapshot.source} snapshot`);
    const state = this.read(now);
    state.history[valid.source] = retained([...(state.history[valid.source] ?? []), valid]);
    this.write(state);
    return state.history;
  }

  recordAttempt(source: BenchSource, now = Date.now()): void {
    const state = this.read(now);
    state.attempts[source] = Math.max(state.attempts[source] ?? 0, now);
    this.write(state);
  }

  /**
   * Machine-wide right to spend one refresh: the same exclusive-create lock `IntelStore` uses, taken on
   * this file. Returns the release function, or `undefined` while a live peer holds it.
   */
  claim(now = Date.now()): (() => void) | undefined {
    return new IntelStore(this.filename).claim(now);
  }

  private write(state: BenchState): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    try {
      fs.renameSync(tmp, this.filename);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** Whether a source may be fetched now: not within 24 h of its newest snapshot, not within 15 minutes of an attempt. */
export function benchRefreshDue(state: BenchState, source: BenchSource, now = Date.now()): boolean {
  const newest = state.history[source]?.at(-1);
  if (newest && now - newest.fetchedAt < BENCH_TTL_MS) return false;
  const attempt = state.attempts[source];
  if (attempt !== undefined && now - attempt < BENCH_RETRY_FLOOR_MS) return false;
  return true;
}
