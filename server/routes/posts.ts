import { Router, type Request } from 'express';
import { db, now } from '../db/index.js';
import { adultFilter, adultUnlocked, can, type SessionUser } from '../auth.js';
import { ah, HttpError, intParam, str } from '../http.js';
import { POST_COLS, POST_FROM, visible, parseCursor, cursorSql, nextCursor, hydratePosts, gridTiles } from '../views.js';
import { parseUpload } from '../media/upload.js';
import { addMediaToPost, createPost, findCreatorByName, indexPost, moveMediaToAuthor, parseMentions, setPostHashtags, type Author } from '../library.js';
import { notify, notifyFollowers } from '../notify.js';

export const posts = Router();

const PAGE = 12;
const GRID = 36;

function loadVisiblePost(req: Request, id: number, includeDeleted = false): any {
  return db.prepare(`SELECT ${POST_COLS} ${POST_FROM} WHERE p.id = ? AND ${visible(req, includeDeleted)}`).get(id);
}

export function canEditPost(user: SessionUser, row: { uploader_id: number | null; user_id: number | null }): boolean {
  return user.role === 'admin' || can(user, 'profiles') || row.uploader_id === user.id || row.user_id === user.id;
}

function notifyMentions(text: string, actor: SessionUser, postId: number, what: string): void {
  for (const name of parseMentions(text)) {
    const u = db.prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(name) as { id: number } | undefined;
    if (u) notify({ userId: u.id, kind: 'mention', actorId: actor.id, postId, text: `${actor.display_name || actor.username} mentioned you in a ${what}` });
  }
}

posts.get('/feed', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor));
  const following = req.query.following === '1';
  const follow = following ? 'AND p.creator_id IN (SELECT creator_id FROM follows WHERE user_id = ?)' : '';
  const args: unknown[] = [...cur.args];
  if (following) args.push(req.user!.id);
  const rows = db
    .prepare(`SELECT ${POST_COLS} ${POST_FROM} WHERE ${visible(req)} AND ${cur.sql} ${follow} ORDER BY p.created_at DESC, p.id DESC LIMIT ${PAGE}`)
    .all(...args) as any[];
  res.json({ items: hydratePosts(rows, req.user!.id), next: nextCursor(rows, PAGE) });
});

/** Converts free text into a safe FTS5 prefix query. */
export function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .replace(/[#@]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_.]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' ') : null;
}

posts.get('/explore', (req, res) => {
  const q = str(req.query.q, 200).trim();
  const cur = cursorSql(parseCursor(req.query.cursor));
  let rows: any[];
  if (q) {
    const fts = ftsQuery(q);
    if (!fts) {
      res.json({ items: [], next: null });
      return;
    }
    rows = db
      .prepare(
        `SELECT p.id, p.created_at ${POST_FROM} WHERE p.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) AND ${visible(req)} AND ${cur.sql}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ${GRID}`,
      )
      .all(fts, ...cur.args) as any[];
  } else {
    rows = db
      .prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE ${visible(req)} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${GRID}`)
      .all(...cur.args) as any[];
  }
  res.json({ items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

posts.get('/search', (req, res) => {
  const q = str(req.query.q, 200).trim().replace(/^[@#]/, '');
  if (!q) {
    res.json({ creators: [], tags: [] });
    return;
  }
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const adult = adultUnlocked(req) ? '' : 'AND c.adult = 0';
  const creators = db
    .prepare(
      `SELECT c.id, c.handle, c.display_name FROM creators c WHERE c.deleted = 0 ${adult} AND (c.handle LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = c.id AND a.alias LIKE ? ESCAPE '\\'))
       ORDER BY (c.handle = ?) DESC, length(c.handle) LIMIT 8`,
    )
    .all(like, like, like, q.toLowerCase()) as any[];
  const tags = db
    .prepare(
      `SELECT h.tag, COUNT(ph.post_id) AS n FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id WHERE h.tag LIKE ? ESCAPE '\\'
       GROUP BY h.id ORDER BY n DESC LIMIT 8`,
    )
    .all(`${q.toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`) as any[];
  res.json({ creators: creators.map((c) => ({ ...c, avatar: `/m/ca/${c.id}` })), tags });
});

posts.get('/videos', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor), 'p.created_at', 'm.id');
  const limit = 10;
  const rows = db
    .prepare(
      `SELECT m.id AS media_id, m.width, m.height, m.duration, ${POST_COLS} ${POST_FROM} JOIN media m ON m.post_id = p.id
       WHERE m.kind = 'video' AND m.missing = 0 AND ${visible(req)} AND ${cur.sql}
       ORDER BY p.created_at DESC, m.id DESC LIMIT ${limit}`,
    )
    .all(...cur.args) as any[];
  const hydrated = new Map(hydratePosts(rows, req.user!.id).map((p) => [p.id, p]));
  const items = rows.map((r) => ({
    media_id: r.media_id,
    url: `/m/${r.media_id}`,
    thumb: `/m/${r.media_id}/t`,
    width: r.width,
    height: r.height,
    duration: r.duration,
    post: hydrated.get(r.id),
  }));
  const last = rows[rows.length - 1];
  res.json({ items, next: rows.length === limit ? `${last.created_at}_${last.media_id}` : null });
});

posts.get('/liked', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor), 'l.created_at', 'p.id');
  const rows = db
    .prepare(
      `SELECT p.id, l.created_at ${POST_FROM} JOIN likes l ON l.post_id = p.id AND l.user_id = ? WHERE ${visible(req)} AND ${cur.sql}
       ORDER BY l.created_at DESC, p.id DESC LIMIT ${GRID}`,
    )
    .all(req.user!.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

posts.get('/hashtags', (req, res) => {
  const rows = db
    .prepare(
      `SELECT h.tag, COUNT(p.id) AS n FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id JOIN posts p ON p.id = ph.post_id
       LEFT JOIN creators c ON c.id = p.creator_id WHERE p.deleted = 0 AND (c.id IS NULL OR c.deleted = 0) AND ${adultFilter(req)}
       GROUP BY h.id HAVING n > 0 ORDER BY n DESC, h.tag LIMIT 500`,
    )
    .all() as any[];
  res.json({ items: rows });
});

posts.get('/hashtags/:tag', (req, res) => {
  const cur = cursorSql(parseCursor(req.query.cursor));
  const rows = db
    .prepare(
      `SELECT p.id, p.created_at ${POST_FROM} JOIN post_hashtags ph ON ph.post_id = p.id JOIN hashtags h ON h.id = ph.hashtag_id
       WHERE h.tag = ? AND ${visible(req)} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${GRID}`,
    )
    .all(req.params.tag.toLowerCase(), ...cur.args) as any[];
  const total = db.prepare('SELECT COUNT(*) FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE h.tag = ?').pluck().get(req.params.tag.toLowerCase());
  res.json({ tag: req.params.tag.toLowerCase(), total, items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

posts.get('/mentions', (req, res) => {
  const q = str(req.query.q, 60).toLowerCase().replace(/[%_\\]/g, '');
  const users = db.prepare("SELECT 'user' AS type, id, username AS handle, display_name AS name FROM users WHERE disabled = 0 AND username LIKE ? LIMIT 5").all(`${q}%`) as any[];
  const adult = adultUnlocked(req) ? '' : 'AND adult = 0';
  const creators = db
    .prepare(`SELECT 'creator' AS type, id, handle, display_name AS name FROM creators WHERE deleted = 0 ${adult} AND (handle LIKE ? OR display_name LIKE ?) LIMIT 8`)
    .all(`${q}%`, `${q}%`) as any[];
  res.json({
    items: [...users.map((u) => ({ ...u, avatar: `/m/ua/${u.id}` })), ...creators.map((c) => ({ ...c, avatar: `/m/ca/${c.id}` }))],
  });
});

posts.get('/posts/:id', (req, res) => {
  const id = intParam(req.params.id);
  const showDeleted = req.query.deleted === '1';
  const row = loadVisiblePost(req, id, showDeleted);
  if (!row || (row.deleted && !canEditPost(req.user!, row))) throw new HttpError(404, 'Post not found');
  const [post] = hydratePosts([row], req.user!.id);
  post.can_edit = canEditPost(req.user!, row);
  res.json(post);
});

function resolveAuthor(req: Request, fields: Record<string, string>): Author {
  const creator = str(fields.creator, 80).trim().replace(/^@/, '');
  if (creator) {
    const c = findCreatorByName(creator);
    if (!c) throw new HttpError(400, `Unknown creator "${creator}"`);
    return { creatorId: c.id };
  }
  return { userId: req.user!.id };
}

posts.post(
  '/posts',
  ah(async (req, res) => {
    const up = await parseUpload(req);
    try {
      if (up.files.length === 0) throw new HttpError(400, 'Add at least one image or video');
      const author = resolveAuthor(req, up.fields);
      const result = await createPost({
        author,
        uploaderId: req.user!.id,
        caption: str(up.fields.caption),
        adult: up.fields.adult === '1',
        files: up.files.map((f) => ({ abs: f.abs, name: f.name })),
      });
      if (!result.postId) throw new HttpError(400, `No usable media: ${result.rejected.map((r) => `${r.name} (${r.reason})`).join(', ')}`);
      notifyMentions(str(up.fields.caption), req.user!, result.postId, 'post');
      if (author.creatorId) notifyFollowers(author.creatorId, result.postId, req.user!.id);
      res.status(201).json({ id: result.postId, rejected: result.rejected });
    } finally {
      await up.cleanup();
    }
  }),
);


posts.patch(
  '/posts/:id',
  ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = loadVisiblePost(req, id, true);
    if (!row) throw new HttpError(404, 'Post not found');
    if (!canEditPost(req.user!, row)) throw new HttpError(403, 'Forbidden');
    const body = req.body ?? {};
    if (typeof body.caption === 'string') {
      const caption = str(body.caption);
      db.transaction(() => {
        db.prepare('UPDATE posts SET caption = ? WHERE id = ?').run(caption, id);
        setPostHashtags(id, caption);
      })();
      notifyMentions(caption, req.user!, id, 'post');
    }
    if (typeof body.adult === 'boolean') db.prepare('UPDATE posts SET adult = ? WHERE id = ?').run(body.adult ? 1 : 0, id);
    if (body.author && typeof body.author === 'object') {
      let author: Author;
      if (body.author.self) author = { userId: req.user!.id };
      else {
        const c = findCreatorByName(str(body.author.creator, 80));
        if (!c) throw new HttpError(400, 'Unknown creator');
        author = { creatorId: c.id };
      }
      await moveMediaToAuthor([id], author);
      db.prepare('UPDATE posts SET creator_id = ?, user_id = ? WHERE id = ?').run(author.creatorId ?? null, author.creatorId ? null : author.userId, id);
    }
    if (Array.isArray(body.removeMedia) && body.removeMedia.length) {
      const remaining = db.prepare('SELECT COUNT(*) FROM media WHERE post_id = ? AND missing = 0').pluck().get(id) as number;
      const toRemove = (body.removeMedia as unknown[]).map(Number).filter(Number.isInteger);
      if (toRemove.length >= remaining) throw new HttpError(400, 'A post needs at least one media item; delete the post instead');
      // Removed media move to a new hidden, deleted post so the file and its row stay recoverable.
      db.transaction(() => {
        const t = now();
        const holder = db
          .prepare('INSERT INTO posts (creator_id, user_id, uploader_id, caption, created_at, imported_at, deleted, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
          .run(row.creator_id, row.user_id, req.user!.id, `Removed from post ${id}`, row.created_at, t, t);
        const upd = db.prepare('UPDATE media SET post_id = ? WHERE id = ? AND post_id = ?');
        for (const mid of toRemove) upd.run(Number(holder.lastInsertRowid), mid, id);
      })();
    }
    if (Array.isArray(body.order)) {
      const upd = db.prepare('UPDATE media SET position = ? WHERE id = ? AND post_id = ?');
      db.transaction(() => (body.order as unknown[]).forEach((mid, i) => upd.run(i, Number(mid), id)))();
    }
    indexPost(id);
    const [post] = hydratePosts([loadVisiblePost(req, id, true)], req.user!.id);
    res.json({ ...post, can_edit: true });
  }),
);

posts.post(
  '/posts/:id/media',
  ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = loadVisiblePost(req, id);
    if (!row) throw new HttpError(404, 'Post not found');
    if (!canEditPost(req.user!, row)) throw new HttpError(403, 'Forbidden');
    const up = await parseUpload(req);
    try {
      const r = await addMediaToPost(id, up.files.map((f) => ({ abs: f.abs, name: f.name })));
      res.json(r);
    } finally {
      await up.cleanup();
    }
  }),
);

posts.delete('/posts/:id', (req, res) => {
  const id = intParam(req.params.id);
  const row = loadVisiblePost(req, id);
  if (!row) throw new HttpError(404, 'Post not found');
  if (!canEditPost(req.user!, row)) throw new HttpError(403, 'Forbidden');
  db.prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').run(now(), id);
  indexPost(id);
  res.json({ ok: true, id });
});

posts.post('/posts/:id/restore', (req, res) => {
  const id = intParam(req.params.id);
  const row = loadVisiblePost(req, id, true);
  if (!row) throw new HttpError(404, 'Post not found');
  if (!canEditPost(req.user!, row)) throw new HttpError(403, 'Forbidden');
  db.prepare('UPDATE posts SET deleted = 0, deleted_at = NULL WHERE id = ?').run(id);
  indexPost(id);
  res.json({ ok: true, id });
});

posts.post('/posts/:id/like', (req, res) => {
  const id = intParam(req.params.id);
  const row = loadVisiblePost(req, id);
  if (!row) throw new HttpError(404, 'Post not found');
  const r = db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(req.user!.id, id, now());
  const owner = row.user_id ?? row.uploader_id;
  if (r.changes && owner) notify({ userId: owner, kind: 'like', actorId: req.user!.id, postId: id, text: `${req.user!.display_name || req.user!.username} liked your post` });
  res.json({ liked: true, like_count: db.prepare('SELECT COUNT(*) FROM likes WHERE post_id = ?').pluck().get(id) });
});

posts.delete('/posts/:id/like', (req, res) => {
  const id = intParam(req.params.id);
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user!.id, id);
  res.json({ liked: false, like_count: db.prepare('SELECT COUNT(*) FROM likes WHERE post_id = ?').pluck().get(id) });
});

posts.get('/posts/:id/comments', (req, res) => {
  const id = intParam(req.params.id);
  if (!loadVisiblePost(req, id)) throw new HttpError(404, 'Post not found');
  const rows = db
    .prepare(
      `SELECT cm.id, cm.body, cm.created_at, u.id AS user_id, u.username, u.display_name FROM comments cm JOIN users u ON u.id = cm.user_id
       WHERE cm.post_id = ? ORDER BY cm.created_at`,
    )
    .all(id) as any[];
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      user: { id: r.user_id, username: r.username, name: r.display_name || r.username, avatar: `/m/ua/${r.user_id}` },
      can_delete: r.user_id === req.user!.id || req.user!.role === 'admin',
    })),
  });
});

posts.post('/posts/:id/comments', (req, res) => {
  const id = intParam(req.params.id);
  const row = loadVisiblePost(req, id);
  if (!row) throw new HttpError(404, 'Post not found');
  const body = str(req.body?.body, 2000).trim();
  if (!body) throw new HttpError(400, 'Comment is empty');
  const r = db.prepare('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, body, now());
  const owner = row.user_id ?? row.uploader_id;
  const who = req.user!.display_name || req.user!.username;
  if (owner) notify({ userId: owner, kind: 'comment', actorId: req.user!.id, postId: id, text: `${who} commented: ${body.slice(0, 80)}` });
  notifyMentions(body, req.user!, id, 'comment');
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

posts.delete('/comments/:id', (req, res) => {
  const id = intParam(req.params.id);
  const c = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(id) as { user_id: number } | undefined;
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'Forbidden');
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  res.json({ ok: true });
});
