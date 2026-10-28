import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { APP_DIRS, mediaAbs, mediaRel, uniqueTarget } from '../media/files.js';
import { dHash } from '../media/probe.js';
import { indexPost } from '../library.js';
import { cookieFor } from '../sync/cookies.js';
import { runProc } from '../sync/runner.js';
import { downloaderVersions } from '../sync/sources.js';
import { sleep, type JobContext } from './scheduler.js';

// --- Duplicates ---------------------------------------------------------------

const DUP_THRESHOLD = Number(process.env.DUP_THRESHOLD || 5);

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Fingerprints images that lack one, then groups lookalikes. Reports only; never deletes. */
export async function runDuplicateScan(ctx: JobContext): Promise<string> {
  const todo = db.prepare("SELECT id, path FROM media WHERE kind = 'image' AND phash IS NULL AND missing = 0 LIMIT 5000").all() as any[];
  const upd = db.prepare('UPDATE media SET phash = ? WHERE id = ?');
  let hashed = 0;
  for (const m of todo) {
    if (ctx.stopped()) break;
    try {
      upd.run(await dHash(mediaAbs(m.path)), m.id);
      hashed++;
    } catch {
      upd.run('error', m.id);
    }
  }
  const rows = db
    .prepare("SELECT m.id, m.phash FROM media m JOIN posts p ON p.id = m.post_id WHERE m.kind = 'image' AND m.missing = 0 AND p.deleted = 0 AND m.phash IS NOT NULL AND m.phash != 'error'")
    .all() as { id: number; phash: string }[];
  const n = rows.length;
  const hi = new Int32Array(n);
  const lo = new Int32Array(n);
  rows.forEach((r, i) => {
    hi[i] = parseInt(r.phash.slice(0, 8), 16) | 0;
    lo[i] = parseInt(r.phash.slice(8, 16), 16) | 0;
  });
  // Union-find over every pair within the threshold.
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const dist = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (i % 2000 === 0) {
      if (ctx.stopped()) return 'Stopped';
      await new Promise((r) => setImmediate(r));
    }
    const a = hi[i];
    const b = lo[i];
    for (let j = i + 1; j < n; j++) {
      const d = popcount32(a ^ hi[j]) + popcount32(b ^ lo[j]);
      if (d <= DUP_THRESHOLD) {
        parent[find(j)] = find(i);
        dist.set(rows[j].id, Math.max(dist.get(rows[j].id) ?? 0, d));
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(rows[i].id);
    groups.set(r, list);
  }
  let created = 0;
  const seen = new Set<string>();
  db.transaction(() => {
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const sig = [...members].sort((x, y) => x - y).join(',');
      seen.add(sig);
      const existing = db.prepare('SELECT id FROM dup_groups WHERE signature = ?').get(sig);
      if (existing) continue;
      const g = db.prepare("INSERT INTO dup_groups (signature, status, created_at) VALUES (?, 'open', ?)").run(sig, now());
      const ins = db.prepare('INSERT INTO dup_members (group_id, media_id, distance) VALUES (?, ?, ?)');
      for (const id of members) ins.run(g.lastInsertRowid, id, dist.get(id) ?? 0);
      created++;
    }
    // Open groups that no longer match anything disappear; decisions (ignored/resolved) are kept.
    const open = db.prepare("SELECT id, signature FROM dup_groups WHERE status = 'open'").all() as any[];
    for (const g of open) if (!seen.has(g.signature)) db.prepare('DELETE FROM dup_groups WHERE id = ?').run(g.id);
  })();
  const openCount = db.prepare("SELECT COUNT(*) FROM dup_groups WHERE status = 'open'").pluck().get();
  return `${hashed} images fingerprinted, ${n} compared, ${created} new groups, ${openCount} open`;
}

// --- Missing files ------------------------------------------------------------

/** Flags rows whose file is gone (and un-flags files that came back). Never deletes rows or files. */
export async function runMissingCheck(ctx: JobContext): Promise<string> {
  const rows = db.prepare('SELECT id, path, missing, post_id FROM media').iterate() as Iterable<any>;
  const changed: { id: number; missing: number; post: number }[] = [];
  let checked = 0;
  for (const r of rows) {
    const gone = fs.existsSync(mediaAbs(r.path)) ? 0 : 1;
    if (gone !== r.missing) changed.push({ id: r.id, missing: gone, post: r.post_id });
    checked++;
  }
  const upd = db.prepare('UPDATE media SET missing = ? WHERE id = ?');
  db.transaction(() => changed.forEach((c) => upd.run(c.missing, c.id)))();
  const posts = new Set(changed.map((c) => c.post));
  posts.forEach(indexPost);
  const nowMissing = changed.filter((c) => c.missing).length;
  ctx.log(`${nowMissing} newly missing, ${changed.length - nowMissing} back`);
  const total = db.prepare('SELECT COUNT(*) FROM media WHERE missing = 1').pluck().get();
  return `${checked} files checked, ${nowMissing} newly missing, ${changed.length - nowMissing} found again, ${total} missing in total`;
}

// --- References & purge -------------------------------------------------------

/** True when any table still points at this media-root path. */
export function isReferenced(rel: string, except: { mediaId?: number; storyId?: number } = {}): boolean {
  const q = [
    ['SELECT 1 FROM media WHERE path = ? AND id != ?', except.mediaId ?? -1],
    ['SELECT 1 FROM stories WHERE path = ? AND id != ?', except.storyId ?? -1],
    ['SELECT 1 FROM creators WHERE (avatar_path = ? OR banner_path = ?)', null],
    ['SELECT 1 FROM users WHERE avatar_path = ?', null],
  ] as const;
  for (const [sql, ex] of q) {
    const args: unknown[] = sql.includes('banner_path') ? [rel, rel] : [rel];
    if (ex !== null) args.push(ex);
    if (db.prepare(sql).get(...args)) return true;
  }
  return false;
}

/**
 * Permanently removes soft-deleted posts. Only posts already flagged deleted
 * are touched, and a file is unlinked only when no table references it.
 */
export async function purgePosts(ids: number[]): Promise<{ posts: number; files: number; kept: number }> {
  let files = 0;
  let kept = 0;
  let posts = 0;
  for (const id of ids) {
    const p = db.prepare('SELECT id FROM posts WHERE id = ? AND deleted = 1').get(id);
    if (!p) continue;
    const media = db.prepare('SELECT id, path FROM media WHERE post_id = ?').all(id) as any[];
    const unlink: string[] = [];
    for (const m of media) {
      if (isReferenced(m.path, { mediaId: m.id })) kept++;
      else unlink.push(m.path);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM dup_members WHERE media_id IN (SELECT id FROM media WHERE post_id = ?)').run(id);
      db.prepare('DELETE FROM media WHERE post_id = ?').run(id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(id);
      db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(id);
    })();
    posts++;
    for (const rel of unlink) {
      await fsp.unlink(mediaAbs(rel)).then(() => files++, () => undefined);
    }
  }
  return { posts, files, kept };
}

// --- Stories ------------------------------------------------------------------

export async function runStoryExpiry(): Promise<string> {
  const expired = db.prepare('UPDATE stories SET expired = 1 WHERE expired = 0 AND expires_at <= ?').run(now()).changes;
  // A week after expiry the file goes, once nothing else references it.
  const old = db.prepare('SELECT id, path FROM stories WHERE expired = 1 AND expires_at <= ?').all(now() - 7 * 86_400_000) as any[];
  let removed = 0;
  for (const s of old) {
    const shared = isReferenced(s.path, { storyId: s.id });
    db.prepare('DELETE FROM stories WHERE id = ?').run(s.id);
    if (!shared) await fsp.unlink(mediaAbs(s.path)).then(() => removed++, () => undefined);
  }
  return `${expired} stories expired, ${removed} old story files removed`;
}

// --- Backups ------------------------------------------------------------------

/** Uses SQLite's online backup API: consistent even while the database is in WAL mode. */
export async function runBackup(ctx: JobContext): Promise<string> {
  await fsp.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.join(config.backupDir, `elitogram-${stamp}.db`);
  await db.backup(dest);
  const check = new Database(dest, { readonly: true });
  try {
    const ok = check.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error(`Backup failed its integrity check: ${ok}`);
  } finally {
    check.close();
  }
  const all = (await fsp.readdir(config.backupDir)).filter((f) => /^elitogram-\d{8}-\d{6}\.db$/.test(f)).sort();
  const remove = all.slice(0, Math.max(0, all.length - config.backupKeep));
  for (const f of remove) await fsp.unlink(path.join(config.backupDir, f)).catch(() => undefined);
  const size = (await fsp.stat(dest)).size;
  ctx.log(`Wrote ${dest}`);
  return `Backup ${path.basename(dest)} (${(size / 1048576).toFixed(1)} MB), ${remove.length} old removed, ${all.length - remove.length} kept`;
}

export function runDbMaintenance(): Promise<string> {
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes;
  const notes = db.prepare('DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL').run(now() - 90 * 86_400_000).changes;
  db.prepare("INSERT INTO search_fts(search_fts) VALUES('optimize')").run();
  db.pragma('optimize');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return Promise.resolve(`${sessions} expired sessions and ${notes} old notifications removed; search index optimised; WAL checkpointed`);
}

// --- Avatars ------------------------------------------------------------------

export async function squareAvatar(srcAbs: string, prefix: string): Promise<string> {
  const dest = await uniqueTarget(APP_DIRS.avatars, `${prefix}_${Date.now()}`, '.webp');
  await sharp(srcAbs, { failOn: 'none' }).rotate().resize(320, 320, { fit: 'cover' }).webp({ quality: 82 }).toFile(dest);
  return mediaRel(dest);
}

/** Fills missing creator avatars: Instagram profile picture when a cookie is set, otherwise the newest image post. */
export async function runAvatarBackfill(ctx: JobContext): Promise<string> {
  const list = db.prepare('SELECT id, handle, ig_handle FROM creators WHERE deleted = 0 AND avatar_path IS NULL LIMIT 200').all() as any[];
  let fromIg = 0;
  let fromPost = 0;
  let igTries = 0;
  for (const c of list) {
    if (ctx.stopped()) break;
    if (c.ig_handle && igTries < 10) {
      const ck = cookieFor(c.handle);
      if (ck && 'cookie' in ck) {
        igTries++;
        const dir = mediaAbs(`${APP_DIRS.tmp}/avatar-${c.id}-${Date.now()}`);
        await fsp.mkdir(dir, { recursive: true });
        try {
          await runProc(config.galleryDlBin, ['--cookies', ck.path, '-D', dir, '--range', '1', `https://www.instagram.com/${c.ig_handle}/avatar/`], { timeoutMs: 120_000 });
          const file = (await fsp.readdir(dir)).find((f) => /\.(jpe?g|png|webp)$/i.test(f));
          if (file) {
            db.prepare('UPDATE creators SET avatar_path = ? WHERE id = ?').run(await squareAvatar(path.join(dir, file), `c${c.id}`), c.id);
            fromIg++;
            continue;
          }
        } catch (err) {
          ctx.log(`${c.handle}: ${(err as Error).message}`);
        } finally {
          await fsp.rm(dir, { recursive: true, force: true });
          await sleep(20_000 + Math.random() * 20_000, ctx);
        }
      }
    }
    const m = db
      .prepare("SELECT m.path FROM media m JOIN posts p ON p.id = m.post_id WHERE p.creator_id = ? AND p.deleted = 0 AND m.kind = 'image' AND m.missing = 0 ORDER BY p.created_at DESC LIMIT 1")
      .get(c.id) as any;
    if (!m) continue;
    try {
      db.prepare('UPDATE creators SET avatar_path = ? WHERE id = ?').run(await squareAvatar(mediaAbs(m.path), `c${c.id}`), c.id);
      fromPost++;
    } catch (err) {
      ctx.log(`${c.handle}: ${(err as Error).message}`);
    }
  }
  return `${list.length} creators without avatar: ${fromIg} from Instagram, ${fromPost} from their newest image`;
}

// --- Downloaders --------------------------------------------------------------

export async function runDownloaderUpdate(ctx: JobContext): Promise<string> {
  if (!config.downloaderPip) return `DOWNLOADER_PIP is not set; current versions: ${JSON.stringify(await downloaderVersions())}`;
  const r = await runProc(config.downloaderPip, ['install', '--no-cache-dir', '--upgrade', 'yt-dlp[default,curl-cffi]', 'gallery-dl'], { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`pip failed: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  const v = await downloaderVersions();
  ctx.log(r.stdout.trim().split('\n').pop() ?? '');
  return `yt-dlp ${v.ytDlp}, gallery-dl ${v.galleryDl}`;
}
