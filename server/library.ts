import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import { db, now } from './db/index.js';
import { creatorDir, mediaAbs, mediaRel, moveFile, placeFile, sha256File, sniffFile, validateHandle, userDir, type Sniffed } from './media/files.js';
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

// --- Creator mentions (Grabbit 3.0.3) ----------------------------------------

export type Platform = 'instagram' | 'tiktok' | null;

/** The platform a post came from, when its source URL or delivery metadata says so. */
export function postPlatform(sourceUrl: string | null | undefined, meta?: string | null): Platform {
  const fromHost = (raw: unknown): Platform => {
    if (typeof raw !== 'string' || !raw) return null;
    let host = raw.toLowerCase();
    try {
      if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
    const is = (d: string) => host === d || host.endsWith(`.${d}`);
    if (is('instagram.com') || host === 'instagram') return 'instagram';
    if (is('tiktok.com') || host === 'tiktok') return 'tiktok';
    return null;
  };
  const p = fromHost(sourceUrl);
  if (p || !meta) return p;
  try {
    const m = JSON.parse(meta);
    return m && typeof m === 'object' ? fromHost(m.platform) : null;
  } catch {
    return null;
  }
}

// Account names each platform allows; anything else is not an account there.
const ACCOUNT_RE: Record<'instagram' | 'tiktok', RegExp> = { instagram: /^[a-z0-9._]{1,30}$/, tiktok: /^[a-z0-9._]{2,24}$/ };

export type MentionPlan =
  | { name: string; action: 'link'; creatorId: number }
  | { name: string; action: 'create' }
  | { name: string; action: 'skip'; reason: 'self' | 'invalid' | 'deleted' | 'other-account' | 'ambiguous' };

/**
 * What one @name in a post's caption should point at, read-only. Live
 * creators always win over deleted ones; a deleted creator is never revived
 * and its name is never handed to a new creator. In order:
 *
 * 1. Platform known: a live creator holding that account on the post's
 *    platform (ig_handle / tiktok_handle). Several claiming the same account
 *    is ambiguous: the mention is skipped rather than guessed.
 * 2. Platform unknown: the distinct live creators that claim the name, as an
 *    account on either platform or as handle or alias. More than one is
 *    ambiguous (Instagram "sam" and TikTok "u-sam" both claim @sam), whichever
 *    of them happens to hold the plain handle.
 * 3. A live creator whose handle or alias is the name, unless it holds a
 *    different account on the post's platform (skipped: accounts on different
 *    platforms are never merged by a mention). One known for the name only
 *    as the OTHER platform's account may be someone else: a separate mention
 *    creator is planned (step 4 applies).
 * 4. Before a new creator is planned: a deleted creator holding the name as
 *    handle or alias, or as the account on the post's platform (either
 *    platform when unknown), skips it ('deleted'), so a deleted "u-sam" for
 *    TikTok @sam is not recreated as "u-sam-2". A live owner found in steps
 *    1-3 is linked first, whatever tombstone shares the name.
 */
export function planMention(name: string, platform: Platform, authorId: number | null): MentionPlan {
  const n = name.toLowerCase();
  if (platform && !ACCOUNT_RE[platform].test(n)) return { name: n, action: 'skip', reason: 'invalid' };
  const col = platform === 'instagram' ? 'ig_handle' : platform === 'tiktok' ? 'tiktok_handle' : null;
  const otherCol = platform === 'instagram' ? 'tiktok_handle' : platform === 'tiktok' ? 'ig_handle' : null;
  const link = (id: number): MentionPlan => (id === authorId ? { name: n, action: 'skip', reason: 'self' } : { name: n, action: 'link', creatorId: id });
  const create = (): MentionPlan => {
    const accountCond = col ? `${col} = ? COLLATE NOCASE` : '(ig_handle = ? COLLATE NOCASE OR tiktok_handle = ? COLLATE NOCASE)';
    const accountArgs = col ? [n] : [n, n];
    if (
      db.prepare('SELECT 1 FROM creators WHERE handle = ? AND deleted = 1').get(n) ||
      db.prepare('SELECT 1 FROM creator_aliases a JOIN creators c ON c.id = a.creator_id WHERE a.alias = ? AND c.deleted = 1').get(n) ||
      db.prepare(`SELECT 1 FROM creators WHERE ${accountCond} AND deleted = 1`).get(...accountArgs)
    )
      return { name: n, action: 'skip', reason: 'deleted' };
    if (validateHandle(n) && validateHandle(mentionHandle(n))) return { name: n, action: 'skip', reason: 'invalid' };
    return { name: n, action: 'create' };
  };
  if (col) {
    const owners = db.prepare(`SELECT id FROM creators WHERE ${col} = ? COLLATE NOCASE AND deleted = 0 ORDER BY id LIMIT 2`).pluck().all(n) as number[];
    if (owners.length > 1) return { name: n, action: 'skip', reason: 'ambiguous' };
    if (owners.length === 1) return link(owners[0]);
  }
  const acct = col ? `c.${col}` : 'NULL';
  const other = otherCol ? `c.${otherCol}` : 'NULL';
  const hit = (db.prepare(`SELECT c.id, ${acct} AS acct, ${other} AS other FROM creators c WHERE c.handle = ? AND c.deleted = 0`).get(n) ??
    db.prepare(`SELECT c.id, ${acct} AS acct, ${other} AS other FROM creator_aliases a JOIN creators c ON c.id = a.creator_id WHERE a.alias = ? AND c.deleted = 0`).get(n)) as
    | { id: number; acct: string | null; other: string | null }
    | undefined;
  if (!platform) {
    // Every distinct live claimant of the name, checked before any of them is taken.
    const claimants = new Set(
      db.prepare('SELECT id FROM creators WHERE (ig_handle = ? COLLATE NOCASE OR tiktok_handle = ? COLLATE NOCASE) AND deleted = 0 ORDER BY id LIMIT 3').pluck().all(n, n) as number[],
    );
    if (hit) claimants.add(hit.id);
    if (claimants.size > 1) return { name: n, action: 'skip', reason: 'ambiguous' };
    if (claimants.size === 1) return link([...claimants][0]);
    return create();
  }
  if (hit) {
    if (hit.acct && hit.acct.toLowerCase() !== n) return { name: n, action: 'skip', reason: 'other-account' };
    if (hit.id === authorId) return { name: n, action: 'skip', reason: 'self' };
    // Known for this name only on the other platform: a separate creator.
    if (!hit.acct && hit.other && hit.other.toLowerCase() === n) {
      if (validateHandle(`u-${n.replace(/^[_.]+/, '')}`)) return { name: n, action: 'skip', reason: 'invalid' };
      return create();
    }
    return link(hit.id);
  }
  return create();
}

/**
 * The preferred creator handle for an @name. Most names are valid handles as
 * they are. One a handle cannot be (it starts with "_" or ".", which Elitogram
 * reserves) becomes "u-" + the name without those: no Instagram or TikTok
 * account has a "-", so it can never take a real account's handle. The
 * written name is kept as an alias and the display name.
 */
export function mentionHandle(name: string): string {
  return validateHandle(name) ? `u-${name.replace(/^[_.]+/, '')}` : name;
}

/**
 * A handle nobody holds for a new mention creator: the name itself when it is
 * a valid handle that no creator (live or deleted) holds as handle or alias,
 * otherwise "u-<name>", "u-<name>-2", "u-<name>-3", ... ("_sam" and "__sam"
 * both prefer "u-sam", so the second gets "u-sam-2").
 */
function freeMentionHandle(name: string): string {
  const taken = db.prepare('SELECT 1 FROM creators WHERE handle = ? UNION ALL SELECT 1 FROM creator_aliases WHERE alias = ?');
  const free = (h: string) => !validateHandle(h) && !taken.get(h, h);
  if (free(name)) return name;
  const base = `u-${name.replace(/^[_.]+/, '')}`;
  for (let i = 1; i <= 1000; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    const h = base.slice(0, 60 - suffix.length) + suffix;
    if (free(h)) return h;
  }
  throw new Error(`No free handle for @${name}`);
}

/**
 * A creator for an @name nobody had. It starts unclassified (never general),
 * not 18+, followed by nobody and with every poller off; origin = 'mention'
 * keeps it out of the avatar fetch and the creator lists until it owns posts.
 * The written name becomes an alias only when no creator holds it yet; a
 * creator made beside one known from the other platform is found again
 * through its own platform account instead.
 */
function createMentionedCreator(name: string, platform: Platform): number {
  const handle = freeMentionHandle(name);
  const res = db
    .prepare(
      `INSERT INTO creators (handle, display_name, ig_handle, tiktok_handle, ig_autopoll, tiktok_autopoll, adult, audience, origin, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 'unknown', 'mention', ?)`,
    )
    .run(handle, handle === name ? '' : name, platform === 'instagram' ? name : null, platform === 'tiktok' ? name : null, now());
  const id = Number(res.lastInsertRowid);
  if (handle !== name && !db.prepare('SELECT 1 FROM creators WHERE handle = ? UNION ALL SELECT 1 FROM creator_aliases WHERE alias = ?').get(name, name)) {
    db.prepare('INSERT INTO creator_aliases (alias, creator_id) VALUES (?, ?)').run(name, id);
  }
  return id;
}

export interface MentionResult {
  linked: number[]; // creator ids now tied to the post
  created: number[]; // of those, creators made here
  skipped: { name: string; reason: string }[];
  changed: boolean; // the post's mention rows changed
}

/**
 * Rebuilds a post's mention rows from its caption: one row per mentioned
 * creator, never the post's own creator. Runs inside the caller's transaction
 * when there is one. The caption, the post and its files are not touched.
 */
export function setPostMentions(postId: number, opts: { create?: boolean } = {}): MentionResult {
  const create = opts.create ?? true;
  const out: MentionResult = { linked: [], created: [], skipped: [], changed: false };
  const p = db.prepare('SELECT caption, creator_id, source_url, meta FROM posts WHERE id = ?').get(postId) as any;
  if (!p) return out;
  const platform = postPlatform(p.source_url, p.meta);
  const want = new Map<number, string>();
  for (const name of parseMentions(p.caption ?? '')) {
    const plan = planMention(name, platform, p.creator_id ?? null);
    if (plan.action === 'skip') {
      out.skipped.push({ name: plan.name, reason: plan.reason });
      continue;
    }
    if (plan.action === 'create' && !create) continue;
    const id = plan.action === 'link' ? plan.creatorId : createMentionedCreator(plan.name, platform);
    if (plan.action === 'create') out.created.push(id);
    if (!want.has(id)) want.set(id, plan.name);
  }
  const have = new Map((db.prepare('SELECT creator_id, name FROM post_mentions WHERE post_id = ?').all(postId) as { creator_id: number; name: string }[]).map((r) => [r.creator_id, r.name]));
  const del = db.prepare('DELETE FROM post_mentions WHERE post_id = ? AND creator_id = ?');
  const ins = db.prepare('INSERT INTO post_mentions (post_id, creator_id, name) VALUES (?, ?, ?) ON CONFLICT(post_id, creator_id) DO UPDATE SET name = excluded.name');
  for (const id of have.keys()) if (!want.has(id)) { del.run(postId, id); out.changed = true; }
  for (const [id, name] of want) if (have.get(id) !== name) { ins.run(postId, id, name); out.changed = true; }
  out.linked = [...want.keys()];
  return out;
}

/**
 * setPostMentions in its own savepoint: a mention that cannot be stored is
 * logged and left out, and never undoes the post, its caption or its edit.
 */
export function linkMentionsSafely(postId: number): MentionResult | null {
  try {
    return db.transaction(() => setPostMentions(postId))();
  } catch (err) {
    console.warn(`Mentions of post ${postId} not stored: ${(err as Error).message}`);
    return null;
  }
}

/** True when the post's hashtag rows differ from what its caption says. */
export function hashtagsStale(postId: number, caption: string): boolean {
  const want = parseHashtags(caption).sort();
  const have = (db.prepare('SELECT h.tag FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.post_id = ?').pluck().all(postId) as string[]).map((t) => t.toLowerCase()).sort();
  return want.length !== have.length || want.some((t, i) => t !== have[i]);
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
      const dest = await placeFile(p.file.abs, dirRel, p.file.name, p.sniff.ext);
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
      linkMentionsSafely(id);
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
    const dest = await placeFile(p.file.abs, dirRel, p.file.name, p.sniff.ext);
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

let moveQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` while no other reassignment (post author change, creator merge)
 * moves files. A reassignment reads the media rows, moves the files and may
 * move them back; two of them interleaving on the same post would leave rows
 * and files apart.
 */
export function withMoveLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = moveQueue.then(fn, fn);
  moveQueue = run.catch(() => undefined);
  return run;
}

/** Moves one media file into `dirRel` and re-points its row. -> true when it moved. */
async function moveOneMedia(m: { id: number; path: string }, dirRel: string): Promise<boolean> {
  if (m.path.startsWith(dirRel + '/')) return false;
  const src = mediaAbs(m.path);
  if (!fs.existsSync(src)) return false;
  const upd = db.prepare('UPDATE media SET path = ? WHERE id = ?');
  const ext = m.path.match(/\.[^./]+$/)?.[0] ?? '';
  const dest = await placeFile(src, dirRel, m.path.split('/').pop() ?? 'file', ext);
  try {
    // Only the row as it was read: a purge may have removed it meanwhile.
    if (db.prepare('UPDATE media SET path = ? WHERE id = ? AND path = ?').run(mediaRel(dest), m.id, m.path).changes === 0) {
      const still = db.prepare('SELECT 1 FROM media WHERE id = ?').get(m.id);
      // A purged row's bytes go too (this call created `dest`); otherwise keep the file and say where it is.
      if (!still) await fsp.unlink(dest).catch(() => undefined);
      else console.error(`Media ${m.id}: its row changed while its file moved to ${dest}`);
      return false;
    }
  } catch (err) {
    // Back to its old name if that is still free, otherwise to a free name
    // beside it; the row follows the file either way.
    try {
      await moveFile(dest, src);
    } catch {
      const srcDir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
      const again = await placeFile(dest, srcDir, m.path.split('/').pop() ?? 'file', ext).catch(() => null);
      if (again) {
        try {
          upd.run(mediaRel(again), m.id);
        } catch (e2) {
          console.error(`Media ${m.id}: row still names ${m.path}; its file is at ${again}: ${(e2 as Error).message}`);
        }
      } else console.error(`Media ${m.id}: row still names ${m.path}; its file is at ${dest}`);
    }
    throw err;
  }
  return true;
}

/**
 * Moves every media file of the given posts into the new author's folder and
 * re-points the rows. Used by "change author" and by merging creators; callers
 * hold withMoveLock. A file never replaces another one (placeFile). Returns the
 * ids of the media it moved, also when it fails part way (`moved` is filled as
 * it goes), so a caller can put them back with returnMediaHome.
 */
export async function moveMediaToAuthor(postIds: number[], author: Author, moved: number[] = []): Promise<number[]> {
  const dirRel = authorDir(author);
  const rows = db
    .prepare(`SELECT id, path FROM media WHERE post_id IN (${postIds.map(() => '?').join(',') || 'NULL'})`)
    .all(...postIds) as { id: number; path: string }[];
  for (const m of rows) if (await moveOneMedia(m, dirRel)) moved.push(m.id);
  if (config.testMoveDelayMs) await new Promise((r) => setTimeout(r, config.testMoveDelayMs));
  return moved;
}

/**
 * Puts each of these media files in the folder of the author of the post that
 * owns its row now (a removed item may meanwhile belong to a holder post).
 * Used after a refused or failed reassignment; errors are logged, not thrown.
 */
export async function returnMediaHome(mediaIds: number[]): Promise<void> {
  for (const id of mediaIds) {
    try {
      const m = db
        .prepare('SELECT m.id, m.path, p.creator_id, p.user_id FROM media m JOIN posts p ON p.id = m.post_id WHERE m.id = ?')
        .get(id) as { id: number; path: string; creator_id: number | null; user_id: number | null } | undefined;
      if (!m) continue;
      await moveOneMedia(m, authorDir(m.creator_id ? { creatorId: m.creator_id } : { userId: m.user_id }));
    } catch (err) {
      console.error(`Could not move media ${id} back: ${(err as Error).message}`);
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

// --- Mention and hashtag backfill (Grabbit 3.0.3) ------------------------------

export const BACKFILL_CURSOR_KEY = 'metadata_backfill_after';

export interface BackfillStats {
  scanned: number;
  postsWithMentions: number;
  newRelations: number;
  removedRelations: number;
  newCreators: number;
  reusedCreators: number;
  skipped: Record<string, number>;
  postsWithStaleTags: number;
  newHashtags: number;
  newTagLinks: number;
  lastId: number;
}

export function emptyBackfillStats(): BackfillStats {
  return { scanned: 0, postsWithMentions: 0, newRelations: 0, removedRelations: 0, newCreators: 0, reusedCreators: 0, skipped: {}, postsWithStaleTags: 0, newHashtags: 0, newTagLinks: 0, lastId: 0 };
}

/** A post whose mentions could not be stored; the backfill checkpoint stays before it. */
export class BackfillStopped extends Error {}

/**
 * One batch of the backfill: the next `limit` live posts after `afterId`, by id.
 * Dry run (apply = false) reads only and counts what applying would write;
 * `seen` carries names, tags and creators across batches so nothing is counted
 * twice. Apply reads the batch and writes it in one write transaction (BEGIN
 * IMMEDIATE, so no caption can change between the read and the write): mention
 * rows, creators for new @names, hashtag rows, and the checkpoint
 * (BACKFILL_CURSOR_KEY) after the last post done. Captions, posts and files are
 * never changed. A post whose mentions cannot be stored writes nothing: the
 * posts before it commit with the checkpoint just before it, and
 * BackfillStopped is thrown, so a rerun retries that post rather than skipping it.
 * Returns the number of posts read (0 = done).
 */
export function metadataBackfillBatch(
  afterId: number,
  limit: number,
  apply: boolean,
  stats: BackfillStats,
  seen: { names: Set<string>; tags: Set<string>; reused: Set<number> },
): number {
  const tagKnown = db.prepare('SELECT 1 FROM hashtags WHERE tag = ?');
  const tagLinked = db.prepare('SELECT 1 FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.post_id = ? AND h.tag = ?');
  const haveRows = db.prepare('SELECT creator_id FROM post_mentions WHERE post_id = ?').pluck();
  type Row = { id: number; caption: string; creator_id: number | null; source_url: string | null; meta: string | null };
  const one = (p: Row) => {
    stats.scanned++;
    stats.lastId = p.id;
    const caption = p.caption ?? '';
    // Hashtags: only a post whose rows differ from its caption is rewritten.
    const tags = parseHashtags(caption);
    const tagsChanged = hashtagsStale(p.id, caption);
    if (tagsChanged) {
      stats.postsWithStaleTags++;
      for (const t of tags) {
        if (!tagKnown.get(t) && !seen.tags.has(t)) {
          seen.tags.add(t);
          stats.newHashtags++;
        }
        if (!tagLinked.get(p.id, t)) stats.newTagLinks++;
      }
      if (apply) {
        setPostHashtags(p.id, caption);
        // Tags are part of the post's search row.
        indexPost(p.id);
      }
    }
    // Mentions.
    const names = parseMentions(caption);
    if (names.length === 0 && (haveRows.all(p.id) as number[]).length === 0) return;
    if (names.length) stats.postsWithMentions++;
    const have = new Set(haveRows.all(p.id) as number[]);
    if (apply) {
      // Throws when a mention cannot be stored; the caller undoes this post.
      const r = setPostMentions(p.id);
      stats.newCreators += r.created.length;
      // A creator made in this run is never counted as reused by a later post.
      for (const id of r.created) seen.reused.add(id);
      for (const id of r.linked) {
        if (!have.has(id)) stats.newRelations++;
        if (!seen.reused.has(id)) {
          seen.reused.add(id);
          stats.reusedCreators++;
        }
      }
      for (const id of have) if (!r.linked.includes(id)) stats.removedRelations++;
      for (const sk of r.skipped) stats.skipped[sk.reason] = (stats.skipped[sk.reason] ?? 0) + 1;
    } else {
      const platform = postPlatform(p.source_url, p.meta);
      const want = new Set<string>();
      for (const name of names) {
        const plan = planMention(name, platform, p.creator_id);
        if (plan.action === 'skip') {
          stats.skipped[plan.reason] = (stats.skipped[plan.reason] ?? 0) + 1;
          continue;
        }
        if (plan.action === 'create') {
          // Every later post naming it links to the creator made for the first one.
          if (!seen.names.has(plan.name)) {
            seen.names.add(plan.name);
            stats.newCreators++;
          }
          if (!want.has(`n:${plan.name}`)) stats.newRelations++;
          want.add(`n:${plan.name}`);
          continue;
        }
        if (want.has(`c:${plan.creatorId}`)) continue;
        want.add(`c:${plan.creatorId}`);
        if (!have.has(plan.creatorId)) stats.newRelations++;
        if (!seen.reused.has(plan.creatorId)) {
          seen.reused.add(plan.creatorId);
          stats.reusedCreators++;
        }
      }
      for (const id of have) if (!want.has(`c:${id}`)) stats.removedRelations++;
    }
  };
  const select = () =>
    db.prepare('SELECT id, caption, creator_id, source_url, meta FROM posts WHERE id > ? AND deleted = 0 ORDER BY id LIMIT ?').all(afterId, limit) as Row[];
  if (!apply) {
    const rows = select();
    rows.forEach(one);
    return rows.length;
  }
  let failed: { id: number; message: string } | null = null;
  const read = db
    .transaction(() => {
      const rows = select();
      const start = stats.lastId;
      for (const p of rows) {
        const before = { ...stats, skipped: { ...stats.skipped } };
        const reusedBefore = new Set(seen.reused);
        try {
          // A savepoint per post: a failed post leaves no partial rows behind.
          db.transaction(() => one(p))();
        } catch (err) {
          Object.assign(stats, before);
          seen.reused.clear();
          for (const id of reusedBefore) seen.reused.add(id);
          failed = { id: p.id, message: (err as Error).message };
          break;
        }
      }
      if (stats.lastId > start && stats.lastId > afterId) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(BACKFILL_CURSOR_KEY, String(stats.lastId));
      }
      return rows.length;
    })
    .immediate();
  if (failed) {
    const f = failed as { id: number; message: string };
    throw new BackfillStopped(`Mentions of post ${f.id} could not be stored (${f.message}); the backfill stopped before it and resumes there`);
  }
  return read;
}
