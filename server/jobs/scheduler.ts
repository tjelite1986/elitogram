import { db, now } from '../db/index.js';

export interface JobContext {
  log: (msg: string) => void;
  /** True once a stop was requested; long jobs check it between units of work. */
  stopped: () => boolean;
}

export interface JobDef {
  name: string;
  title: string;
  description: string;
  defaultInterval: number; // minutes
  run: (ctx: JobContext) => Promise<string>;
}

interface Running {
  startedAt: number;
  log: string[];
  stop: boolean;
}

const defs = new Map<string, JobDef>();
const running = new Map<string, Running>();
let timer: NodeJS.Timeout | null = null;

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * Jobs that share an interval must not fire in the same second: each job gets
 * a fixed offset derived from its name, spread over up to ten minutes.
 */
export function staggeredNext(name: string, intervalMin: number, from = now()): number {
  const spread = Math.min(intervalMin * 60_000, 10 * 60_000);
  return from + intervalMin * 60_000 + (hash(name) % Math.max(spread, 1));
}

export function registerJob(def: JobDef): void {
  defs.set(def.name, def);
  // New jobs start disabled.
  db.prepare('INSERT OR IGNORE INTO jobs (name, enabled, interval_minutes) VALUES (?, 0, ?)').run(def.name, def.defaultInterval);
}

export function listJobs() {
  const rows = db.prepare('SELECT * FROM jobs').all() as any[];
  const byName = new Map(rows.map((r) => [r.name, r]));
  return [...defs.values()].map((d) => {
    const r = byName.get(d.name) ?? {};
    const run = running.get(d.name);
    return {
      name: d.name,
      title: d.title,
      description: d.description,
      enabled: !!r.enabled,
      interval_minutes: r.interval_minutes ?? d.defaultInterval,
      last_run_at: r.last_run_at ?? null,
      next_run_at: r.enabled ? (r.next_run_at ?? null) : null,
      last_status: r.last_status ?? null,
      last_result: r.last_result ?? null,
      running: !!run,
      running_since: run?.startedAt ?? null,
      running_log: run ? run.log.slice(-20) : [],
    };
  });
}

export function updateJob(name: string, patch: { enabled?: boolean; interval_minutes?: number }): void {
  if (!defs.has(name)) throw new Error('Unknown job');
  const row = db.prepare('SELECT enabled, interval_minutes FROM jobs WHERE name = ?').get(name) as any;
  const enabled = patch.enabled ?? !!row.enabled;
  const interval = patch.interval_minutes ?? row.interval_minutes;
  if (!Number.isInteger(interval) || interval < 1 || interval > 60 * 24 * 30) throw new Error('Interval must be 1 minute to 30 days');
  db.prepare('UPDATE jobs SET enabled = ?, interval_minutes = ?, next_run_at = ? WHERE name = ?').run(enabled ? 1 : 0, interval, enabled ? staggeredNext(name, interval) : null, name);
}

export function isRunning(name: string): boolean {
  return running.has(name);
}

export function stopJob(name: string): boolean {
  const r = running.get(name);
  if (r) r.stop = true;
  return !!r;
}

/** Runs a job now. Returns false when it is already running. */
export function runJob(name: string, trigger: 'schedule' | 'manual' = 'manual'): Promise<boolean> {
  const def = defs.get(name);
  if (!def) throw new Error('Unknown job');
  if (running.has(name)) return Promise.resolve(false);
  const state: Running = { startedAt: now(), log: [], stop: false };
  running.set(name, state);
  const ctx: JobContext = {
    log: (msg) => {
      state.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
      if (state.log.length > 500) state.log.shift();
    },
    stopped: () => state.stop,
  };
  ctx.log(`Started (${trigger})`);
  return def
    .run(ctx)
    .then(
      (result) => ['ok', result],
      (err: Error) => {
        console.error(`Job ${name} failed:`, err);
        return ['error', err.message] as const;
      },
    )
    .then(([status, result]) => {
      const row = db.prepare('SELECT enabled, interval_minutes FROM jobs WHERE name = ?').get(name) as any;
      db.prepare('UPDATE jobs SET last_run_at = ?, last_status = ?, last_result = ?, next_run_at = ? WHERE name = ?').run(
        state.startedAt,
        status,
        String(result).slice(0, 4000),
        row.enabled ? staggeredNext(name, row.interval_minutes) : null,
        name,
      );
      running.delete(name);
      return true;
    });
}

function tick(): void {
  const due = db.prepare('SELECT name FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').pluck().all(now()) as string[];
  for (const name of due) {
    if (!defs.has(name) || running.has(name)) continue;
    void runJob(name, 'schedule');
  }
}

export function startScheduler(): void {
  // Enabled jobs that lost their next run (or were due while the app was down) get a fresh staggered slot.
  const rows = db.prepare('SELECT name, interval_minutes, next_run_at FROM jobs WHERE enabled = 1').all() as any[];
  for (const r of rows) {
    if (!r.next_run_at || r.next_run_at < now()) {
      const offset = (hash(r.name) % 300_000) + 60_000;
      db.prepare('UPDATE jobs SET next_run_at = ? WHERE name = ?').run(now() + offset, r.name);
    }
  }
  timer = setInterval(tick, 20_000);
  timer.unref();
}

export const sleep = (ms: number, ctx?: JobContext): Promise<void> =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - started >= ms || ctx?.stopped()) {
        clearInterval(iv);
        resolve();
      }
    }, Math.min(ms, 1000));
  });
