import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.js';
import { APP_DIRS, mediaAbs, mediaIdentity } from './files.js';
import { thumbnail } from './probe.js';

/**
 * The thumbnail cache (`_thumbs/<xx>/<key>_<width>.webp`) as Grabbit's Smart
 * Duplicate Manager sees it. Every file here is rebuilt from the original on
 * the next request, so removing one never loses anything.
 *
 * - current: `m<id>-<hash12>_<w>.webp` whose key is the row's mediaIdentity.
 * - legacy:  `m<id>_<w>.webp`, the name before thumbnails carried the media
 *            identity. Nothing asks for it any more.
 * - stale:   `m<id>-<hash12>_<w>.webp` for a row that is gone, or whose id was
 *            reused by another file (SQLite reuses the highest purged id).
 * - partial: a `.tmp` an interrupted write left behind, older than an hour.
 * Anything else in the folder is not ours to judge and is left alone.
 *
 * A legacy file whose media has a current thumbnail of the same width is
 * also a duplicate: the same picture stored twice under two names.
 */

const NAME = /^m(\d+)(?:-([0-9a-f]{12}))?_(\d+)\.webp$/;
const TMP = /\.webp\.\d+(?:-[0-9a-f]{16})?\.tmp$/;
const TMP_AGE_MS = 60 * 60 * 1000;
export const REBUILD_LIMIT = 100;
// At most this many files go per clean call; the owner runs it again for more.
export const CLEAN_LIMIT = 100;
const REBUILD_WIDTH = 480;
// Grabbit gives each call 20 s. A rebuild stops starting new thumbnails after
// this long and answers with what it made; the caller calls again for the
// rest. EGRAM_DEDUPE_REBUILD_BUDGET_MS overrides it (tests use a tiny one).
const REBUILD_BUDGET_MS = 15_000;
function rebuildBudgetMs(): number {
  const v = Number(process.env.EGRAM_DEDUPE_REBUILD_BUDGET_MS);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, REBUILD_BUDGET_MS) : REBUILD_BUDGET_MS;
}

/** Tells a long call that its client went away, so it stops starting work. */
export interface Cancel {
  cancelled: () => boolean;
}
const never: Cancel = { cancelled: () => false };
type StopReason = 'time' | 'disconnected' | null;

/** Thrown by a walk whose time ran out; the rebuild answers with stopReason 'time'. */
class OutOfTime extends Error {}

/** When a walk must stop: out of time (throws OutOfTime) or client gone. */
interface WalkLimit {
  expired: () => boolean;
}
const unlimited: WalkLimit = { expired: () => false };

type Kind = 'current' | 'legacy' | 'stale' | 'partial' | 'other';
interface Entry {
  rel: string;
  kind: Kind;
  bytes: number;
  id: number | null;
  width: number | null;
  duplicate: boolean;
}

function identities(): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of db.prepare('SELECT id, sha256, path, created_at FROM media').iterate() as Iterable<any>) {
    out.set(r.id, mediaIdentity(r));
  }
  return out;
}

async function walk(limit: WalkLimit = unlimited): Promise<Entry[]> {
  const root = mediaAbs(APP_DIRS.thumbs);
  const ids = identities();
  if (limit.expired()) throw new OutOfTime();
  const out: Entry[] = [];
  // The cache must be a real folder of this app's: a symlinked _thumbs would
  // point the cleaner at someone else's files.
  if (!realDir(root)) return out;
  let shards: fs.Dirent[];
  try {
    shards = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    let files: fs.Dirent[];
    try {
      files = await fsp.readdir(path.join(root, shard.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const rel = `${APP_DIRS.thumbs}/${shard.name}/${f.name}`;
      let st: fs.Stats;
      try {
        st = await fsp.lstat(path.join(root, shard.name, f.name));
      } catch {
        continue;
      }
      const m = NAME.exec(f.name);
      let kind: Kind = 'other';
      let id: number | null = null;
      let width: number | null = null;
      if (m) {
        id = Number(m[1]);
        width = Number(m[3]);
        if (!m[2]) kind = 'legacy';
        else kind = ids.get(id) === `${m[1]}-${m[2]}` ? 'current' : 'stale';
      } else if (TMP.test(f.name) && now - st.mtimeMs > TMP_AGE_MS) {
        kind = 'partial';
      }
      out.push({ rel, kind, bytes: st.size, id, width, duplicate: false });
    }
    // Let requests through between shards.
    await new Promise((r) => setImmediate(r));
    if (limit.expired()) throw new OutOfTime();
  }
  const current = new Set(out.filter((e) => e.kind === 'current').map((e) => `${e.id}_${e.width}`));
  for (const e of out) if (e.kind === 'legacy' && current.has(`${e.id}_${e.width}`)) e.duplicate = true;
  return out;
}

function present(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function realDir(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}

// Read again just before a delete: a stale thumbnail whose id was reused by a
// row with the same identity in the meantime is current again and stays.
const identityOf = db.prepare('SELECT id, sha256, path, created_at FROM media WHERE id = ?');
function stillRemovable(e: Entry): boolean {
  const abs = mediaAbs(e.rel);
  if (!realDir(mediaAbs(APP_DIRS.thumbs)) || !realDir(path.dirname(abs))) return false;
  if (e.kind !== 'stale') return true;
  const m = NAME.exec(path.basename(e.rel));
  const row = m ? (identityOf.get(Number(m[1])) as any) : null;
  return !(row && m && mediaIdentity(row) === `${m[1]}-${m[2]}`);
}

const removable = (e: Entry) => e.kind === 'legacy' || e.kind === 'stale' || e.kind === 'partial';

// Media that would get a thumbnail and has no current one at the default width.
function missing(entries: Entry[]): { id: number; path: string; kind: 'image' | 'video'; ident: string; done?: boolean }[] {
  const have = new Set(entries.filter((e) => e.kind === 'current' && e.width === REBUILD_WIDTH).map((e) => e.id));
  const rows = db
    .prepare(
      `SELECT m.id, m.path, m.kind, m.sha256, m.created_at FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.missing = 0 AND p.deleted = 0 ORDER BY p.created_at DESC, m.id`,
    )
    .all() as any[];
  return rows.filter((r) => !have.has(r.id)).map((r) => ({ id: r.id, path: r.path, kind: r.kind, ident: mediaIdentity(r) }));
}

const sum = (list: Entry[]) => list.reduce((n, e) => n + e.bytes, 0);

export async function cacheStatus() {
  const entries = await walk();
  const thumbs = entries.filter((e) => e.kind !== 'other');
  const orphans = entries.filter(removable);
  const dups = entries.filter((e) => e.duplicate);
  const by = (k: Kind) => entries.filter((e) => e.kind === k);
  return {
    thumbs: thumbs.length,
    thumbBytes: sum(thumbs),
    orphans: orphans.length,
    orphanBytes: sum(orphans),
    duplicates: dups.length,
    duplicateBytes: sum(dups),
    missing: missing(entries).length,
    kinds: {
      current: { files: by('current').length, bytes: sum(by('current')) },
      legacy: { files: by('legacy').length, bytes: sum(by('legacy')) },
      stale: { files: by('stale').length, bytes: sum(by('stale')) },
      partial: { files: by('partial').length, bytes: sum(by('partial')) },
      other: { files: by('other').length, bytes: sum(by('other')) },
    },
    note: 'Thumbnails are made on first view, so "missing" only means not viewed yet. Unused ones are older names (legacy), thumbnails of removed or replaced files (stale) and interrupted writes.',
  };
}

let busy = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw Object.assign(new Error('A cache cleanup or rebuild is already running'), { status: 409 });
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

export function cacheClean(dryRun: boolean, cancel: Cancel = never) {
  return exclusive(async () => {
    const list = (await walk()).filter(removable);
    const batch = list.slice(0, CLEAN_LIMIT);
    if (dryRun) {
      return { dryRun: true, files: list.length, bytes: sum(list), duplicates: list.filter((e) => e.duplicate).length, limit: CLEAN_LIMIT, nextBatch: { files: batch.length, bytes: sum(batch) } };
    }
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    const errors: string[] = [];
    let stopReason: StopReason = null;
    // Walk the whole list until CLEAN_LIMIT files are removed: entries that
    // became current again or were already gone do not use up the batch, or
    // a run of them at the front would stall every later call. Twenty real
    // errors stop the call.
    for (const e of list) {
      if (files >= CLEAN_LIMIT || errors.length >= 20) break;
      // Checked before every unlink: once Grabbit has gone, nothing more is removed.
      if (cancel.cancelled()) {
        stopReason = 'disconnected';
        break;
      }
      if (!stillRemovable(e)) {
        skipped++;
        continue;
      }
      try {
        await fsp.unlink(mediaAbs(e.rel));
        files++;
        bytes += e.bytes;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') skipped++;
        else errors.push(`${e.rel}: ${(err as Error).message}`);
      }
    }
    // Shard folders stay, even empty: a thumbnail() that just made one would
    // otherwise lose it before its write.
    console.log(`[dedupe] cache clean: removed ${files} unused thumbnails (${bytes} bytes)`);
    return { dryRun: false, files, bytes, skipped, errors, remaining: Math.max(0, list.length - files - skipped), stoppedEarly: stopReason !== null, stopReason };
  });
}

// Rebuild memory, per process: media that failed, or whose thumbnail is still
// being made in the background after a call ran out of time. Later calls skip
// them for REBUILD_PARK_MS, so one slow or broken video at the head of the
// list cannot take every batch's budget and keep the healthy files behind it
// from ever being reached. Keyed by media id; an entry for an older identity
// (the file was replaced) does not count. retryFailed clears the failures.
const REBUILD_PARK_MS = 30 * 60 * 1000;
const FAILURES_LISTED = 20;
interface Parked {
  state: 'inflight' | 'failed';
  ident: string;
  at: number;
  error?: string;
}
const parked = new Map<number, Parked>();

function pruneParked(now: number) {
  for (const [id, p] of parked) if (now - p.at > REBUILD_PARK_MS) parked.delete(id);
}

const shortError = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

function parkFailed(id: number, ident: string, err: unknown) {
  parked.set(id, { state: 'failed', ident, at: Date.now(), error: shortError(err) });
}

export interface RebuildOptions {
  /** Date.now() at route entry: the time budget counts from here. */
  startedAt?: number;
  /** Forget earlier failures first, so this call tries those media again. */
  retryFailed?: boolean;
}

export function cacheRebuild(dryRun: boolean, cancel: Cancel = never, opts: RebuildOptions = {}) {
  const started = opts.startedAt ?? Date.now();
  const budget = rebuildBudgetMs();
  return exclusive(async () => {
    // A _thumbs that exists but is not a real folder (a symlink or a file)
    // would have the rebuild write through it into someone else's files.
    if (present(mediaAbs(APP_DIRS.thumbs)) && !realDir(mediaAbs(APP_DIRS.thumbs))) {
      throw Object.assign(new Error('The thumbnail folder is not a real folder of this app; nothing was written'), { status: 409 });
    }
    pruneParked(Date.now());
    if (opts.retryFailed && !dryRun) for (const [id, p] of parked) if (p.state === 'failed') parked.delete(id);
    // The budget covers discovery too: a slow cache walk or DB query must not
    // leave a slow encode enough time to push the answer past Grabbit's 20 s.
    const timeLeft = () => budget - (Date.now() - started);
    let todo: ReturnType<typeof missing>;
    try {
      const entries = await walk({ expired: () => !dryRun && (timeLeft() <= 0 || cancel.cancelled()) });
      todo = missing(entries);
    } catch (err) {
      if (!(err instanceof OutOfTime)) throw err;
      return {
        dryRun: false, made: 0, failed: 0, failures: listFailures(), missing: null, remaining: null, skipped: 0, inProgress: 0,
        stoppedEarly: true, stopReason: (cancel.cancelled() ? 'disconnected' : 'time') as StopReason, discoveryIncomplete: true,
      };
    }
    const isParked = (m: { id: number; ident: string }) => parked.get(m.id)?.ident === m.ident;
    const work = todo.filter((m) => !isParked(m));
    const skipped = todo.length - work.length;
    if (dryRun) return { dryRun: true, missing: todo.length, skipped, limit: Math.min(REBUILD_LIMIT, work.length) };
    let made = 0;
    let failed = 0;
    let inProgress = 0;
    let stopReason: StopReason = null;
    for (const m of work.slice(0, REBUILD_LIMIT)) {
      // Nothing new starts once the time is spent or Grabbit has gone.
      if (cancel.cancelled()) {
        stopReason = 'disconnected';
        break;
      }
      const left = timeLeft();
      if (left <= 0) {
        stopReason = 'time';
        break;
      }
      // The same check per write, for the folder and the shard it lands in.
      const key = `m${m.ident}`;
      const shard = mediaAbs(`${APP_DIRS.thumbs}/${key.slice(-2).padStart(2, '0')}`);
      if (present(mediaAbs(APP_DIRS.thumbs)) && !realDir(mediaAbs(APP_DIRS.thumbs))) break;
      if (present(shard) && !realDir(shard)) {
        failed++;
        parkFailed(m.id, m.ident, 'Thumbnail folder is not a real folder');
        continue;
      }
      // A slow video does not hold the answer past the budget: it finishes in
      // the background like a thumbnail made on view, and is parked as in
      // flight so later calls go past it instead of waiting on it again.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((r) => {
        timer = setTimeout(() => r('late'), left);
      });
      const job = thumbnail(m.path, m.kind, key, REBUILD_WIDTH);
      try {
        const r = await Promise.race([job, late]);
        if (r === 'late') {
          inProgress++;
          stopReason = 'time';
          parked.set(m.id, { state: 'inflight', ident: m.ident, at: Date.now() });
          job.then(
            () => {
              if (parked.get(m.id)?.state === 'inflight') parked.delete(m.id);
            },
            (err) => parkFailed(m.id, m.ident, err),
          );
          break;
        }
        made++;
        m.done = true;
      } catch (err) {
        failed++;
        parkFailed(m.id, m.ident, err);
      } finally {
        clearTimeout(timer);
      }
    }
    // missing: media still without a thumbnail, parked ones included.
    // remaining: of those, the ones a next call would try (parked ones are
    // left out), so a caller looping while remaining > 0 comes to an end.
    const missingNow = todo.filter((m) => !m.done);
    const remaining = missingNow.filter((m) => !isParked(m)).length;
    return {
      dryRun: false, made, failed, failures: listFailures(), missing: missingNow.length, remaining, skipped, inProgress,
      stoppedEarly: stopReason !== null, stopReason, discoveryIncomplete: false,
    };
  });
}

/** The most recent parked failures, newest first, at most FAILURES_LISTED. */
function listFailures(): { id: number; error: string; at: number }[] {
  return [...parked.entries()]
    .filter(([, p]) => p.state === 'failed')
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, FAILURES_LISTED)
    .map(([id, p]) => ({ id, error: p.error ?? 'failed', at: p.at }));
}
