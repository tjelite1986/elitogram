import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { db, now } from './db/index.js';
import { creatorDir, mediaAbs, mediaRel, moveFile, sha256File, sniffFile, uniqueTarget, validateHandle, userDir, type Sniffed } from './media/files.js';
import { dHash, probe } from './media/probe.js';
import { effectiveAudience } from './audience.js';

export interface IncomingFile {
  abs: string; // current location (temp dir, import folder, download dir)
  name: string; // original name, used as a hint for the stored name
}

export interface Author {
  creatorId?: number | null;
  userId?: number | null;
}

export class MediaRejected extends Error {}

export function parseHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,64})/gu)) tags.add(m[1].toLowerCase());
  return [...tags];
}

export function parseMentions(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w.])@([a-zA-Z0-9._-]{1,60})/g)) names.add(m[1].replace(/\.$/, '').toLowerCase());
  return [...names];
}

export function setPostHashtags(postId: number, caption: string): void {
  db.prepare('DELETE FROM post_hashtags WHERE post_id = ?').run(postId);
  const ins = db.prepare('INSERT INTO hashtags (tag) VALUES (?) ON CONFLICT(tag) DO UPDATE SET tag = tag RETURNING id');
  const link = db.prepare('INSERT OR IGNORE INTO post_hashtags (post_id, hashtag_id) VALUES (?, ?)');
  for (const tag of parseHashtags(caption)) {
    const row = ins.get(tag) as { id: number };
    link.run(postId, row.id);
  }
}

/** Rebuilds the search row for one post. */
export function indexPost(postId: number): void {
  const p = db
    .prepare(
      `SELECT p.caption, p.deleted, COALESCE(c.handle, u.username, '') AS handle, COALESCE(c.display_name, u.display_name, '') AS dn,
        (SELECT group_concat(alias, ' ') FROM creator_aliases a WHERE a.creator_id = p.creator_id) AS aliases,
        (SELECT group_concat(h.tag, ' ') FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.post_id = p.id) AS tags
       FROM posts p LEFT JOIN creators c ON c.id = p.creator_id LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    )
    .get(postId) as any;
  db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(postId);
  if (!p || p.deleted) return;
  db.prepare('INSERT INTO search_fts (rowid, caption, names, tags) VALUES (?, ?, ?, ?)').run(
    postId,
    p.caption,
    [p.handle, p.dn, p.aliases ?? ''].join(' '),
    p.tags ?? '',
  );
}

export function reindexCreator(creatorId: number): void {
  const ids = db.prepare('SELECT id FROM posts WHERE creator_id = ?').pluck().all(creatorId) as number[];
  db.transaction(() => ids.forEach(indexPost))();
}

function authorDir(author: Author): string {
  if (author.creatorId) {
    const c = db.prepare('SELECT handle FROM creators WHERE id = ?').get(author.creatorId) as { handle: string } | undefined;
    if (!c) throw new Error('Unknown creator');
    return creatorDir(c.handle);
  }
  if (author.userId) return userDir(author.userId);
  throw new Error('Post needs an author');
}

interface Prepared {
  file: IncomingFile;
  sniff: Sniffed;
  sha: string;
}

/** Checks the bytes of every file before anything is moved. */
async function prepare(files: IncomingFile[], skipKnown: boolean): Promise<{ ok: Prepared[]; rejected: { name: string; reason: string }[] }> {
  const ok: Prepared[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const known = db.prepare('SELECT 1 FROM media WHERE sha256 = ? LIMIT 1');
  const seen = new Set<string>();
  for (const file of files) {
    const st = await fsp.stat(file.abs).catch(() => null);
    if (!st || !st.isFile() || st.size === 0) {
      rejected.push({ name: file.name, reason: 'empty or missing' });
      continue;
    }
    const sniff = await sniffFile(file.abs);
    if (!sniff) {
      rejected.push({ name: file.name, reason: 'not a supported image or video (checked the bytes)' });
      continue;
    }
    const sha = await sha256File(file.abs);
    if (seen.has(sha) || (skipKnown && known.get(sha))) {
      rejected.push({ name: file.name, reason: 'already in the library' });
      continue;
    }
    seen.add(sha);
    ok.push({ file, sniff, sha });
  }
  return { ok, rejected };
}

export interface CreatePostInput {
  author: Author;
  uploaderId?: number | null;
  caption?: string;
  createdAt?: number;
  sourceUrl?: string | null;
  sourceKey?: string | null;
  adult?: boolean;
  audience?: 'general' | 'unknown' | 'review';
  meta?: Record<string, unknown> | null;
  files: IncomingFile[];
  skipKnown?: boolean; // skip files whose bytes are already in the library
  /**
   * Asked inside the insert transaction, after the files were moved and probed.
   * Throws to refuse; the files then go back where they came from. Used for
   * checks that may change while the files are being handled (the destination
   * creator's classification). May return the audience to store instead of
   * `audience`.
   */
  beforeInsert?: () => 'general' | 'unknown' | 'review' | void;
}

export interface CreatePostResult {
  postId: number | null;
  added: number;
  rejected: { name: string; reason: string }[];
}

/**
 * Validates, moves into the author's folder, probes and records a new post.
 * Files that fail validation stay where they are.
 */
export async function createPost(input: CreatePostInput): Promise<CreatePostResult> {
  const { ok, rejected } = await prepare(input.files, input.skipKnown ?? false);
  if (ok.length === 0) return { postId: null, added: 0, rejected };
  const dirRel = authorDir(input.author);
  const placed: { abs: string; p: Prepared; meta: Awaited<ReturnType<typeof probe>> }[] = [];
  try {
    for (const p of ok) {
      const dest = await uniqueTarget(dirRel, p.file.name, p.sniff.ext);
      await moveFile(p.file.abs, dest);
      let meta;
      try {
        meta = await probe(dest, p.sniff.kind);
      } catch (err) {
        // Unreadable media goes back where it came from.
        await moveFile(dest, p.file.abs).catch(() => undefined);
        rejected.push({ name: p.file.name, reason: `could not be read: ${(err as Error).message}` });
        continue;
      }
      placed.push({ abs: dest, p, meta });
    }
    if (placed.length === 0) return { postId: null, added: 0, rejected };
    const hashes = await Promise.all(placed.map((x) => (x.p.sniff.kind === 'image' ? dHash(x.abs).catch(() => null) : null)));
    const t = now();
    const postId = db.transaction(() => {
      const audience = input.beforeInsert?.() || input.audience;
      const caption = (input.caption ?? '').slice(0, 5000);
      const res = db
        .prepare(
          `INSERT INTO posts (creator_id, user_id, uploader_id, caption, created_at, imported_at, source_url, source_key, adult, audience, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.author.creatorId ?? null,
          input.author.creatorId ? null : (input.author.userId ?? null),
          input.uploaderId ?? null,
          caption,
          // File mtimes carry fractional milliseconds; feed cursors only accept whole numbers.
          Math.round(input.createdAt ?? t),
          t,
          input.sourceUrl ?? null,
          input.sourceKey ?? null,
          input.adult ? 1 : 0,
          audience === 'general' || audience === 'review' ? audience : 'unknown',
          input.meta ? JSON.stringify(input.meta) : null,
        );
      const id = Number(res.lastInsertRowid);
      const insMedia = db.prepare(
        `INSERT INTO media (post_id, position, kind, mime, path, size, width, height, duration, sha256, phash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      placed.forEach((x, i) => {
        insMedia.run(id, i, x.p.sniff.kind, x.p.sniff.mime, mediaRel(x.abs), fs.statSync(x.abs).size, x.meta.width, x.meta.height, x.meta.duration, x.p.sha, hashes[i], t);
      });
      setPostHashtags(id, caption);
      indexPost(id);
      return id;
    })();
    return { postId, added: placed.length, rejected };
  } catch (err) {
    // Database failed after files moved: put them back so nothing is orphaned.
    for (const x of placed) await moveFile(x.abs, x.p.file.abs).catch(() => undefined);
    throw err;
  }
}

/** The post's effective audience as stored right now. */
export function currentPostAudience(postId: number): 'adult' | 'general' | 'unknown' {
  const row = db
    .prepare('SELECT p.adult, p.audience, c.adult AS c_adult, c.audience AS c_audience FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE p.id = ?')
    .get(postId) as any;
  return row ? effectiveAudience(row) : 'unknown';
}

/**
 * Adds media to an existing post (edit page, late importer deliveries).
 * `mayJoin` is asked again right before each row is inserted, in the same
 * synchronous step, because the post may have been reclassified while files
 * were being probed; a refused file goes back to where it came from.
 */
export async function addMediaToPost(postId: number, files: IncomingFile[], skipKnown = false, mayJoin?: () => boolean): Promise<CreatePostResult> {
  const post = db.prepare('SELECT creator_id, user_id FROM posts WHERE id = ?').get(postId) as { creator_id: number | null; user_id: number | null } | undefined;
  if (!post) throw new Error('Post not found');
  const { ok, rejected } = await prepare(files, skipKnown);
  const dirRel = authorDir({ creatorId: post.creator_id, userId: post.user_id });
  let pos = (db.prepare('SELECT COALESCE(MAX(position), -1) FROM media WHERE post_id = ?').pluck().get(postId) as number) + 1;
  let added = 0;
  for (const p of ok) {
    const dest = await uniqueTarget(dirRel, p.file.name, p.sniff.ext);
    await moveFile(p.file.abs, dest);
    let meta;
    try {
      meta = await probe(dest, p.sniff.kind);
    } catch (err) {
      await moveFile(dest, p.file.abs).catch(() => undefined);
      rejected.push({ name: p.file.name, reason: `could not be read: ${(err as Error).message}` });
      continue;
    }
    const ph = p.sniff.kind === 'image' ? await dHash(dest).catch(() => null) : null;
    const inserted = db.transaction(() => {
      if (mayJoin && !mayJoin()) return false;
      db.prepare(
        `INSERT INTO media (post_id, position, kind, mime, path, size, width, height, duration, sha256, phash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(postId, pos++, p.sniff.kind, p.sniff.mime, mediaRel(dest), fs.statSync(dest).size, meta.width, meta.height, meta.duration, p.sha, ph, now());
      return true;
    })();
    if (!inserted) {
      await moveFile(dest, p.file.abs).catch(() => undefined);
      rejected.push({ name: p.file.name, reason: 'the post was classified general meanwhile' });
      continue;
    }
    added++;
  }
  return { postId, added, rejected };
}

/**
 * Moves every media file of the given posts into the new author's folder and
 * re-points the rows. Used by "change author" and by merging creators.
 */
/**
 * Moves a file to a free name in `dirRel` without ever replacing a file: two
 * moves (a reassignment and its undo, say) may pick the same free name at once,
 * and the loser takes the next one.
 */
async function moveNoClobber(src: string, dirRel: string, hint: string, ext: string): Promise<string> {
  for (let i = 0; ; i++) {
    const dest = await uniqueTarget(dirRel, hint, ext);
    try {
      // A hard link fails with EEXIST instead of replacing; then the source goes.
      await fsp.link(src, dest);
      await fsp.unlink(src);
      return dest;
    } catch (err: any) {
      if (err.code === 'EEXIST' && i < 20) continue;
      if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
    }
    try {
      // Another file system: copy without replacing, then remove the source.
      await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      await fsp.unlink(src);
      return dest;
    } catch (err: any) {
      if (err.code === 'EEXIST' && i < 20) continue;
      throw err;
    }
  }
}

export async function moveMediaToAuthor(postIds: number[], author: Author): Promise<void> {
  const dirRel = authorDir(author);
  const rows = db
    .prepare(`SELECT id, path FROM media WHERE post_id IN (${postIds.map(() => '?').join(',') || 'NULL'})`)
    .all(...postIds) as { id: number; path: string }[];
  const upd = db.prepare('UPDATE media SET path = ? WHERE id = ?');
  for (const m of rows) {
    if (m.path.startsWith(dirRel + '/')) continue;
    const src = mediaAbs(m.path);
    if (!fs.existsSync(src)) continue;
    const ext = m.path.match(/\.[^./]+$/)?.[0] ?? '';
    const dest = await moveNoClobber(src, dirRel, m.path.split('/').pop() ?? 'file', ext);
    try {
      upd.run(mediaRel(dest), m.id);
    } catch (err) {
      await moveFile(dest, src).catch(() => undefined);
      throw err;
    }
  }
}

export function findCreatorByName(name: string): { id: number; handle: string } | undefined {
  const n = name.trim().toLowerCase();
  return (db.prepare('SELECT id, handle FROM creators WHERE handle = ? AND deleted = 0').get(n) ??
    db.prepare('SELECT c.id, c.handle FROM creator_aliases a JOIN creators c ON c.id = a.creator_id WHERE a.alias = ? AND c.deleted = 0').get(n)) as
    | { id: number; handle: string }
    | undefined;
}

export function createCreator(handle: string, fields: { displayName?: string; adult?: boolean } = {}): number {
  const h = handle.trim().toLowerCase();
  const err = validateHandle(h);
  if (err) throw new MediaRejected(err);
  const existing = db.prepare('SELECT id, deleted FROM creators WHERE handle = ?').get(h) as { id: number; deleted: number } | undefined;
  if (existing && !existing.deleted) throw new MediaRejected(`Creator "${h}" already exists`);
  if (existing) {
    db.prepare('UPDATE creators SET deleted = 0 WHERE id = ?').run(existing.id);
    return existing.id;
  }
  if (db.prepare('SELECT 1 FROM creator_aliases WHERE alias = ?').get(h)) throw new MediaRejected(`"${h}" is already an alias of another creator`);
  const res = db
    .prepare('INSERT INTO creators (handle, display_name, adult, created_at) VALUES (?, ?, ?, ?)')
    .run(h, fields.displayName ?? '', fields.adult ? 1 : 0, now());
  return Number(res.lastInsertRowid);
}
