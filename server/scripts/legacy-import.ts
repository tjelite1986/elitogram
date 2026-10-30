/**
 * One-off migration of the old Elitogram library into this app.
 *
 *   node dist/server/scripts/legacy-import.js --db /legacy-db/elitogram.db --src /legacy [--user thomas] [--limit N] [--dry-run]
 *
 * Reads the old database and media tree read-only. Every file is copied into the
 * temp folder and then goes through createPost, so the same byte checks, probing
 * and duplicate detection apply as for any other import. Posts carry the source
 * key "legacy:<old id>", which makes a re-run skip what is already in.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, now } from '../db/index.js';
import { createCreator, createPost, findCreatorByName, reindexCreator, type IncomingFile } from '../library.js';
import { APP_DIRS, ensureMediaDirs, mediaAbs, validateHandle } from '../media/files.js';
import { squareAvatar } from '../jobs/maintenance.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

const dryRun = process.argv.includes('--dry-run');
const limit = Number(arg('limit', '0')) || Infinity;
const srcRoot = path.resolve(arg('src'));
const old = new Database(arg('db'), { readonly: true, fileMustExist: true });
const userName = arg('user', 'thomas');

const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`);

/** Old timestamps are SQLite datetime('now') text, i.e. UTC without a zone. */
function oldTime(s: string | null): number {
  const t = s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN;
  return Number.isFinite(t) ? t : now();
}

function srcAbs(key: string): string {
  const abs = path.resolve(srcRoot, key);
  if (!abs.startsWith(srcRoot + path.sep)) throw new Error(`Key escapes source root: ${key}`);
  return abs;
}

const user = db.prepare('SELECT id FROM users WHERE username = ?').get(userName) as { id: number } | undefined;
if (!user) throw new Error(`No user named ${userName}`);

// --- Creators -------------------------------------------------------------

interface OldCreator {
  id: number;
  username: string;
  display_name: string | null;
  bio: string | null;
  is_adult: number;
  created_at: string;
  avatar: string | null;
  x_bio: string | null;
  links_json: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
}

const oldCreators = old
  .prepare(
    `SELECT c.id, c.username, c.display_name, c.bio, c.is_adult, c.created_at, h.avatar_key AS avatar,
       x.bio AS x_bio, x.links_json, x.instagram_handle, x.tiktok_handle
     FROM post_creators c
     LEFT JOIN handle_avatars h ON h.handle = c.username
     LEFT JOIN profile_extras x ON x.handle = c.username
     WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_creator_id = c.id AND p.is_deleted = 0)`,
  )
  .all() as OldCreator[];

// member handle -> primary handle; a member's posts land on the primary creator.
const linkOf = new Map(
  (old.prepare('SELECT member_handle, primary_handle FROM profile_links').all() as { member_handle: string; primary_handle: string }[]).map((l) => [
    l.member_handle.toLowerCase(),
    l.primary_handle.toLowerCase(),
  ]),
);

function parseLinks(json: string | null): { label: string; url: string }[] {
  try {
    const v = JSON.parse(json ?? '[]');
    if (!Array.isArray(v)) return [];
    return v
      .map((l: any) => ({ label: String(l?.label ?? '').slice(0, 60), url: String(l?.url ?? '').slice(0, 500) }))
      .filter((l) => /^https?:\/\//i.test(l.url))
      .slice(0, 10);
  } catch {
    return [];
  }
}

const creatorIdByOld = new Map<number, number>();
const stats = { creatorsNew: 0, creatorsMerged: 0, aliases: 0, avatars: 0, posts: 0, files: 0, skippedKnown: 0, rejected: 0, already: 0, failed: 0 };

function ensureCreator(handle: string, c?: OldCreator): number | null {
  const h = handle.toLowerCase();
  if (validateHandle(h)) {
    log(`skip creator "${h}": ${validateHandle(h)}`);
    return null;
  }
  const found = findCreatorByName(h);
  if (found) {
    if (c && !dryRun) {
      const row = db.prepare('SELECT display_name, bio, links, ig_handle, tiktok_handle FROM creators WHERE id = ?').get(found.id) as any;
      const set = (col: string, v: string | null | undefined): void => {
        if (v) db.prepare(`UPDATE creators SET ${col} = ? WHERE id = ?`).run(v, found.id);
      };
      if (!row.display_name || row.display_name === h) set('display_name', c.display_name?.slice(0, 120));
      if (!row.bio) set('bio', (c.x_bio || c.bio)?.slice(0, 2000));
      if (row.links === '[]' && parseLinks(c.links_json).length) set('links', JSON.stringify(parseLinks(c.links_json)));
      if (!row.ig_handle) set('ig_handle', c.instagram_handle?.toLowerCase());
      if (!row.tiktok_handle) set('tiktok_handle', c.tiktok_handle?.toLowerCase());
    }
    stats.creatorsMerged++;
    return found.id;
  }
  stats.creatorsNew++;
  if (dryRun) return -1;
  const id = createCreator(h, { displayName: c?.display_name?.slice(0, 120) ?? '', adult: !!c?.is_adult });
  db.prepare('UPDATE creators SET bio = ?, links = ?, ig_handle = ?, tiktok_handle = ?, created_at = ? WHERE id = ?').run(
    (c?.x_bio || c?.bio || '').slice(0, 2000),
    JSON.stringify(parseLinks(c?.links_json ?? null)),
    c?.instagram_handle?.toLowerCase() || null,
    c?.tiktok_handle?.toLowerCase() || null,
    c ? oldTime(c.created_at) : now(),
    id,
  );
  return id;
}

const byHandle = new Map(oldCreators.map((c) => [c.username.toLowerCase(), c]));
for (const c of oldCreators) {
  const h = c.username.toLowerCase();
  const primary = linkOf.get(h);
  // A member that is already its own creator here stays separate.
  if (primary && !findCreatorByName(h)) continue;
  const id = ensureCreator(h, c);
  if (id !== null) creatorIdByOld.set(c.id, id);
}
for (const c of oldCreators) {
  const h = c.username.toLowerCase();
  const primary = linkOf.get(h);
  if (!primary || creatorIdByOld.has(c.id)) continue;
  const pid = ensureCreator(primary, byHandle.get(primary));
  if (pid === null) continue;
  creatorIdByOld.set(c.id, pid);
  if (!dryRun && !db.prepare('SELECT 1 FROM creator_aliases WHERE alias = ?').get(h)) {
    db.prepare('INSERT INTO creator_aliases (alias, creator_id) VALUES (?, ?)').run(h, pid);
    reindexCreator(pid);
  }
  stats.aliases++;
}
log(`creators: ${stats.creatorsNew} new, ${stats.creatorsMerged} merged, ${stats.aliases} aliases`);

// --- Avatars --------------------------------------------------------------

if (!dryRun) {
  ensureMediaDirs();
  for (const c of oldCreators) {
    const id = creatorIdByOld.get(c.id);
    if (!id || id < 0 || !c.avatar) continue;
    const row = db.prepare('SELECT avatar_path FROM creators WHERE id = ?').get(id) as { avatar_path: string | null };
    if (row.avatar_path) continue;
    const src = srcAbs(c.avatar);
    if (!fs.existsSync(src)) continue;
    try {
      db.prepare('UPDATE creators SET avatar_path = ? WHERE id = ?').run(await squareAvatar(src, `c${id}`), id);
      stats.avatars++;
    } catch (err) {
      log(`avatar ${c.username}: ${(err as Error).message}`);
    }
  }
  log(`avatars: ${stats.avatars}`);
}

// --- Posts ----------------------------------------------------------------

interface OldPost {
  id: number;
  author_user_id: number | null;
  author_creator_id: number | null;
  caption: string | null;
  is_adult: number;
  created_at: string;
}

const oldPosts = old
  .prepare('SELECT id, author_user_id, author_creator_id, caption, is_adult, created_at FROM posts WHERE is_deleted = 0 ORDER BY id')
  .all() as OldPost[];
const oldMedia = old.prepare('SELECT storage_key FROM post_media WHERE post_id = ? ORDER BY position, id');
const haveKey = db.prepare('SELECT 1 FROM posts WHERE source_key = ?');
const tmpRoot = mediaAbs(`${APP_DIRS.tmp}/legacy`);
const started = Date.now();
let done = 0;

for (const p of oldPosts) {
  if (done >= limit) break;
  const key = `legacy:${p.id}`;
  if (haveKey.get(key)) {
    stats.already++;
    continue;
  }
  done++;
  const author = p.author_creator_id ? { creatorId: creatorIdByOld.get(p.author_creator_id) ?? null } : { userId: user.id };
  if (author.creatorId === null) {
    stats.failed++;
    continue;
  }
  const keys = (oldMedia.all(p.id) as { storage_key: string }[]).map((m) => m.storage_key);
  if (dryRun) {
    stats.files += keys.length;
    continue;
  }
  const dir = path.join(tmpRoot, String(p.id));
  try {
    await fsp.mkdir(dir, { recursive: true });
    const files: IncomingFile[] = [];
    for (const [i, k] of keys.entries()) {
      // The old app suffixed stored names with " [id_N]"; the clean name is the better hint.
      const name = path.basename(k).replace(/ \[id_\d+\]/, '');
      const abs = path.join(dir, `${i}_${name}`);
      await fsp.copyFile(srcAbs(k), abs);
      files.push({ abs, name });
    }
    const res = await createPost({
      author,
      uploaderId: author.creatorId ? null : user.id,
      caption: p.caption ?? '',
      createdAt: oldTime(p.created_at),
      sourceKey: key,
      adult: !!p.is_adult,
      files,
      skipKnown: true,
    });
    if (res.postId) stats.posts++;
    stats.files += res.added;
    for (const r of res.rejected) {
      if (r.reason === 'already in the library') stats.skippedKnown++;
      else {
        stats.rejected++;
        log(`post ${p.id} ${r.name}: ${r.reason}`);
      }
    }
  } catch (err) {
    stats.failed++;
    log(`post ${p.id} failed: ${(err as Error).message}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  if (done % 500 === 0) {
    const rate = done / ((Date.now() - started) / 1000);
    log(`${done}/${oldPosts.length} posts, ${rate.toFixed(1)}/s ${JSON.stringify(stats)}`);
  }
}

// --- Likes and follows ----------------------------------------------------

if (!dryRun) {
  const newPostId = db.prepare('SELECT id FROM posts WHERE source_key = ?').pluck();
  let likes = 0;
  for (const l of old.prepare('SELECT post_id, created_at FROM post_likes').all() as { post_id: number; created_at: string }[]) {
    const id = newPostId.get(`legacy:${l.post_id}`) as number | undefined;
    if (id) likes += db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(user.id, id, oldTime(l.created_at)).changes;
  }
  let follows = 0;
  for (const f of old.prepare("SELECT target_id, created_at FROM follows WHERE target_type = 'creator'").all() as { target_id: number; created_at: string }[]) {
    const id = creatorIdByOld.get(f.target_id);
    if (id) follows += db.prepare('INSERT OR IGNORE INTO follows (user_id, creator_id, created_at) VALUES (?, ?, ?)').run(user.id, id, oldTime(f.created_at)).changes;
  }
  log(`likes: ${likes}, follows: ${follows}`);
}

log(`${dryRun ? 'dry run ' : ''}done in ${Math.round((Date.now() - started) / 1000)} s ${JSON.stringify(stats)}`);
old.close();
