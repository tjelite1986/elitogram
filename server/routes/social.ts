import { Router, type Request } from 'express';
import { db, now } from '../db/index.js';
import { adultUnlocked } from '../auth.js';
import { scopeOf } from '../audience.js';
import { HttpError, intParam, str } from '../http.js';
import { POST_FROM, visible, parseCursor, cursorSql, nextCursor, gridTiles } from '../views.js';

/**
 * Grabbit 3.0 phase 2: the routes Grabbit's Social & Photos module needs on top
 * of the classic app: a media-level photo grid, category facets, collections,
 * favorites and viewing history. Every list goes through visible(), so the
 * audience scope and the 18+ gate apply exactly as they do elsewhere.
 */
export const social = Router();

const GRID = 36;
const PHOTOS = 60;

function loadVisiblePostId(req: Request, id: number): boolean {
  return !!db.prepare(`SELECT 1 ${POST_FROM} WHERE p.id = ? AND ${visible(req)}`).get(id);
}

// --- Photos: one tile per image, not per post --------------------------------

social.get('/photos', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor), 'p.created_at', 'm.id');
  const orient =
    req.query.orient === 'portrait'
      ? 'AND m.height > m.width * 1.1'
      : req.query.orient === 'landscape'
        ? 'AND m.width > m.height * 1.1'
        : req.query.orient === 'square'
          ? 'AND m.width > 0 AND m.height > 0 AND m.width <= m.height * 1.1 AND m.height <= m.width * 1.1'
          : '';
  const handle = str(req.query.creator, 80).trim().toLowerCase().replace(/^@/, '');
  const byCreator = handle ? 'AND c.handle = ?' : '';
  const rows = db
    .prepare(
      `SELECT m.id AS media_id, m.width, m.height, m.size, p.id, p.created_at, p.adult, p.audience, c.adult AS c_adult, c.audience AS c_audience,
         c.handle AS c_handle, u.username AS u_username
       ${POST_FROM} JOIN media m ON m.post_id = p.id
       WHERE m.kind = 'image' AND m.missing = 0 AND ${visible(req)} ${orient} ${byCreator} AND ${cur.sql}
       ORDER BY p.created_at DESC, m.id DESC LIMIT ${PHOTOS}`,
    )
    .all(...(handle ? [handle] : []), ...cur.args) as any[];
  const last = rows[rows.length - 1];
  res.json({
    items: rows.map((r) => ({
      media_id: r.media_id,
      post_id: r.id,
      url: `/m/${r.media_id}`,
      thumb: `/m/${r.media_id}/t`,
      width: r.width,
      height: r.height,
      size: r.size,
      created_at: r.created_at,
      author_handle: r.c_handle ?? r.u_username ?? null,
      audience: r.adult || r.c_adult ? 'adult' : r.audience === 'general' || r.c_audience === 'general' ? 'general' : 'unknown',
    })),
    next: rows.length === PHOTOS ? `${last.created_at}_${last.media_id}` : null,
  });
});

// --- Categories: kind and orientation facets plus the top tags ---------------

const categoryCache = new Map<string, { at: number; fp: string; body: unknown }>();
const CATEGORY_TTL = 60_000;

/**
 * The visibility revision (migration 5): triggers bump it in the same
 * transaction as any change to posts, creators, media or hashtags that decides
 * what a scope can see, so a cached answer is reused only while nothing changed.
 */
function visibilityFingerprint(): string {
  return String(db.prepare('SELECT rev FROM visibility_rev WHERE id = 1').pluck().get());
}

social.get('/categories', (req, res) => {
  const key = `${scopeOf(req) ?? '-'}|${adultUnlocked(req) ? 1 : 0}`;
  const fp = visibilityFingerprint();
  const hit = categoryCache.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < CATEGORY_TTL) {
    res.json(hit.body);
    return;
  }
  // Aggregated in SQL: a fixed-size answer, whatever the size of the library.
  // A post with any video is a video post; orientation comes from its first item.
  const f = db
    .prepare(
      `WITH v AS (SELECT p.id ${POST_FROM} WHERE ${visible(req)}),
       m1 AS (SELECT m.post_id, m.kind, m.width, m.height, ROW_NUMBER() OVER (PARTITION BY m.post_id ORDER BY m.position, m.id) AS rn
              FROM media m JOIN v ON v.id = m.post_id WHERE m.missing = 0),
       pp AS (SELECT post_id, MAX(kind = 'video') AS video, MAX(CASE WHEN rn = 1 THEN width END) AS w, MAX(CASE WHEN rn = 1 THEN height END) AS h
              FROM m1 GROUP BY post_id)
       SELECT COUNT(*) AS total, TOTAL(video) AS video,
         TOTAL(w > 0 AND h > w * 1.1) AS portrait, TOTAL(h > 0 AND w > h * 1.1) AS landscape,
         TOTAL(w > 0 AND h > 0 AND w <= h * 1.1 AND h <= w * 1.1) AS square
       FROM pp`,
    )
    .get() as { total: number; video: number; portrait: number; landscape: number; square: number };
  const kinds = { image: f.total - f.video, video: f.video };
  const orients = { portrait: f.portrait, landscape: f.landscape, square: f.square };
  const tags = db
    .prepare(
      `SELECT h.tag, COUNT(p.id) AS n FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id JOIN posts p ON p.id = ph.post_id
       LEFT JOIN creators c ON c.id = p.creator_id LEFT JOIN users u ON u.id = p.user_id
       WHERE ${visible(req)} GROUP BY h.id ORDER BY n DESC, h.tag LIMIT 40`,
    )
    .all() as any[];
  const body = { total: f.total, kinds, orients, tags };
  categoryCache.set(key, { at: Date.now(), fp, body });
  res.json(body);
});

// --- Collections --------------------------------------------------------------

function ownCollection(req: Request, id: number): any {
  const c = db.prepare('SELECT id, name, created_at, updated_at FROM collections WHERE id = ? AND user_id = ?').get(id, req.user!.id);
  if (!c) throw new HttpError(404, 'Collection not found');
  return c;
}

function collectionName(v: unknown): string {
  const name = str(v, 80).trim();
  if (!name) throw new HttpError(400, 'Name the collection');
  return name;
}

function uniqueNameError(err: unknown): never {
  if (err instanceof Error && /UNIQUE/.test(err.message)) throw new HttpError(409, 'You already have a collection with that name');
  throw err;
}

social.get('/collections', (req, res) => {
  const list = db.prepare('SELECT id, name, created_at, updated_at FROM collections WHERE user_id = ? ORDER BY updated_at DESC, id DESC').all(req.user!.id) as any[];
  // Counts and covers only include posts the caller may see in the current scope.
  const count = db.prepare(`SELECT COUNT(*) ${POST_FROM} JOIN collection_items ci ON ci.post_id = p.id WHERE ci.collection_id = ? AND ${visible(req)}`).pluck();
  const cover = db.prepare(
    `SELECT p.id, p.created_at ${POST_FROM} JOIN collection_items ci ON ci.post_id = p.id WHERE ci.collection_id = ? AND ${visible(req)} ORDER BY ci.added_at DESC LIMIT 1`,
  );
  res.json({
    items: list.map((c) => {
      const row = cover.get(c.id) as any;
      return { ...c, count: count.get(c.id), cover: row ? (gridTiles([row])[0] ?? null) : null };
    }),
  });
});

social.post('/collections', (req, res) => {
  const name = collectionName(req.body?.name);
  const t = now();
  try {
    const r = db.prepare('INSERT INTO collections (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(req.user!.id, name, t, t);
    res.status(201).json({ id: Number(r.lastInsertRowid), name });
  } catch (err) {
    uniqueNameError(err);
  }
});

social.patch('/collections/:id', (req, res) => {
  const c = ownCollection(req, intParam(req.params.id));
  const name = collectionName(req.body?.name);
  try {
    db.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), c.id);
  } catch (err) {
    uniqueNameError(err);
  }
  res.json({ id: c.id, name });
});

social.delete('/collections/:id', (req, res) => {
  const c = ownCollection(req, intParam(req.params.id));
  // Removes the collection and its item links only; the posts stay untouched.
  db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

social.get('/collections/:id/posts', (req, res) => {
  const c = ownCollection(req, intParam(req.params.id));
  const cur = cursorSql(parseCursor(req.query.cursor), 'ci.added_at', 'p.id');
  const rows = db
    .prepare(
      `SELECT p.id, ci.added_at AS created_at ${POST_FROM} JOIN collection_items ci ON ci.post_id = p.id
       WHERE ci.collection_id = ? AND ${visible(req)} AND ${cur.sql} ORDER BY ci.added_at DESC, p.id DESC LIMIT ${GRID}`,
    )
    .all(c.id, ...cur.args) as any[];
  res.json({ collection: c, items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

social.post('/collections/:id/items', (req, res) => {
  const c = ownCollection(req, intParam(req.params.id));
  const postId = intParam(req.body?.post_id);
  if (!loadVisiblePostId(req, postId)) throw new HttpError(404, 'Post not found');
  const t = now();
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, post_id, added_at) VALUES (?, ?, ?)').run(c.id, postId, t);
    db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(t, c.id);
  })();
  res.json({ ok: true });
});

social.delete('/collections/:id/items/:postId', (req, res) => {
  const c = ownCollection(req, intParam(req.params.id));
  db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND post_id = ?').run(c.id, intParam(req.params.postId));
  res.json({ ok: true });
});

/** Which of the caller's collections hold this post (for the "save to" sheet). */
social.get('/posts/:id/collections', (req, res) => {
  const id = intParam(req.params.id);
  if (!loadVisiblePostId(req, id)) throw new HttpError(404, 'Post not found');
  const ids = db
    .prepare('SELECT ci.collection_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE c.user_id = ? AND ci.post_id = ?')
    .pluck()
    .all(req.user!.id, id);
  res.json({ items: ids });
});

// --- Favorites ---------------------------------------------------------------

social.post('/posts/:id/favorite', (req, res) => {
  const id = intParam(req.params.id);
  if (!loadVisiblePostId(req, id)) throw new HttpError(404, 'Post not found');
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, post_id, created_at) VALUES (?, ?, ?)').run(req.user!.id, id, now());
  res.json({ favorited: true });
});

social.delete('/posts/:id/favorite', (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND post_id = ?').run(req.user!.id, intParam(req.params.id));
  res.json({ favorited: false });
});

social.get('/favorites', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor), 'f.created_at', 'p.id');
  const rows = db
    .prepare(
      `SELECT p.id, f.created_at ${POST_FROM} JOIN favorites f ON f.post_id = p.id AND f.user_id = ?
       WHERE ${visible(req)} AND ${cur.sql} ORDER BY f.created_at DESC, p.id DESC LIMIT ${GRID}`,
    )
    .all(req.user!.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

// --- Viewing history ------------------------------------------------------------

const HISTORY_KEEP = 1000;

social.post('/posts/:id/view', (req, res) => {
  const id = intParam(req.params.id);
  if (!loadVisiblePostId(req, id)) throw new HttpError(404, 'Post not found');
  db.transaction(() => {
    db.prepare(
      'INSERT INTO post_views (user_id, post_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT (user_id, post_id) DO UPDATE SET viewed_at = excluded.viewed_at',
    ).run(req.user!.id, id, now());
    // History is a convenience, not an archive: keep the newest entries per user.
    db.prepare(
      `DELETE FROM post_views WHERE user_id = ? AND post_id NOT IN (SELECT post_id FROM post_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT ${HISTORY_KEEP})`,
    ).run(req.user!.id, req.user!.id);
  })();
  res.json({ ok: true });
});

social.get('/history', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor), 'v.viewed_at', 'p.id');
  const rows = db
    .prepare(
      `SELECT p.id, v.viewed_at AS created_at ${POST_FROM} JOIN post_views v ON v.post_id = p.id AND v.user_id = ?
       WHERE ${visible(req)} AND ${cur.sql} ORDER BY v.viewed_at DESC, p.id DESC LIMIT ${GRID}`,
    )
    .all(req.user!.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

social.delete('/history', (req, res) => {
  const r = db.prepare('DELETE FROM post_views WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true, removed: r.changes });
});
