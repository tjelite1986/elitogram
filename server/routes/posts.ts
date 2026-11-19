import { Router, type Request } from 'express';
import { db, now } from '../db/index.js';
import { adultFilter, adultUnlocked, can, type SessionUser } from '../auth.js';
import { ah, HttpError, intParam, str } from '../http.js';
import { creatorScopeSql, effectiveAudience, isScoped, parseClassify, scopeOf, scopeSql } from '../audience.js';
import { POST_COLS, POST_FROM, visible, parseCursor, cursorSql, nextCursor, hydratePosts, gridTiles } from '../views.js';
import { parseUpload } from '../media/upload.js';
import { addMediaToPost, createPost, currentPostAudience, findCreatorByName, indexPost, moveMediaToAuthor, linkMentionsSafely, parseMentions, returnMediaHome, setPostHashtags, withMoveLock, type Author } from '../library.js';
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
  res.json({ items: hydratePosts(rows, req.user!.id, req), next: nextCursor(rows, PAGE) });
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

/** First visible media item of post `p`, for kind and orientation filters. */
const FIRST_MEDIA = 'SELECT {col} FROM media mf WHERE mf.post_id = p.id AND mf.missing = 0 ORDER BY mf.position, mf.id LIMIT 1';

/**
 * Optional explore facets: `kind` (image|video: any video in the post makes it
 * a video post) and `orient` (portrait|landscape|square, from the first item;
 * within 10% counts as square). Unknown values are ignored.
 */
export function facetSql(query: Record<string, unknown>): string {
  const parts: string[] = [];
  const hasVideo = "EXISTS (SELECT 1 FROM media mv WHERE mv.post_id = p.id AND mv.missing = 0 AND mv.kind = 'video')";
  if (query.kind === 'video') parts.push(hasVideo);
  else if (query.kind === 'image') parts.push(`NOT ${hasVideo}`);
  const w = `(${FIRST_MEDIA.replace('{col}', 'mf.width')})`;
  const h = `(${FIRST_MEDIA.replace('{col}', 'mf.height')})`;
  if (query.orient === 'portrait') parts.push(`${h} > ${w} * 1.1`);
  else if (query.orient === 'landscape') parts.push(`${w} > ${h} * 1.1`);
  else if (query.orient === 'square') parts.push(`${w} > 0 AND ${h} > 0 AND ${w} <= ${h} * 1.1 AND ${h} <= ${w} * 1.1`);
  return parts.length ? parts.join(' AND ') : '1=1';
}

posts.get('/explore', (req, res) => {
  const q = str(req.query.q, 200).trim();
  const cur = cursorSql(parseCursor(req.query.cursor));
  const facets = facetSql(req.query);
  let rows: any[];
  if (q) {
    const fts = ftsQuery(q);
    if (!fts) {
      res.json({ items: [], next: null });
      return;
    }
    rows = db
      .prepare(
        `SELECT p.id, p.created_at ${POST_FROM} WHERE p.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) AND ${visible(req)} AND ${facets} AND ${cur.sql}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ${GRID}`,
      )
      .all(fts, ...cur.args) as any[];
  } else {
    rows = db
      .prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE ${visible(req)} AND ${facets} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${GRID}`)
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
  const scope = scopeOf(req);
  const creators = db
    .prepare(
      `SELECT c.id, c.handle, c.display_name, c.adult, c.audience FROM creators c WHERE c.deleted = 0 ${adult} AND ${creatorScopeSql(scope)} AND (c.handle LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = c.id AND a.alias LIKE ? ESCAPE '\\'))
       ORDER BY (c.handle = ?) DESC, length(c.handle) LIMIT 8`,
    )
    .all(like, like, like, q.toLowerCase()) as any[];
  // A scoped request counts (and so offers) only tags on posts it may see.
  const tagSql = scope
    ? `SELECT h.tag, COUNT(p.id) AS n FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id JOIN posts p ON p.id = ph.post_id
       LEFT JOIN creators c ON c.id = p.creator_id WHERE h.tag LIKE ? ESCAPE '\\' AND p.deleted = 0 AND (c.id IS NULL OR c.deleted = 0) AND ${adultFilter(req)} AND ${scopeSql(scope)}
       GROUP BY h.id HAVING n > 0 ORDER BY n DESC LIMIT 8`
    : `SELECT h.tag, COUNT(ph.post_id) AS n FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id WHERE h.tag LIKE ? ESCAPE '\\'
       GROUP BY h.id ORDER BY n DESC LIMIT 8`;
  const tags = db
    .prepare(tagSql)
    .all(`${q.toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`) as any[];
  // Each creator names its audience, so a proxy (Grabbit's gateway) can check every hit.
  res.json({
    creators: creators.map((c) => ({
      id: c.id,
      handle: c.handle,
      display_name: c.display_name,
      audience: c.adult ? 'adult' : c.audience === 'general' ? 'general' : 'unknown',
      avatar: `/m/ca/${c.id}`,
    })),
    tags,
  });
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
  const hydrated = new Map(hydratePosts(rows, req.user!.id, req).map((p) => [p.id, p]));
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
       LEFT JOIN creators c ON c.id = p.creator_id WHERE p.deleted = 0 AND (c.id IS NULL OR c.deleted = 0) AND ${adultFilter(req)} AND ${scopeSql(scopeOf(req))}
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
  // A scoped total counts only what the scope can see, so it never hints at hidden posts.
  const total = scopeOf(req)
    ? db
        .prepare(`SELECT COUNT(*) ${POST_FROM} JOIN post_hashtags ph ON ph.post_id = p.id JOIN hashtags h ON h.id = ph.hashtag_id WHERE h.tag = ? AND ${visible(req)}`)
        .pluck()
        .get(req.params.tag.toLowerCase())
    : db.prepare('SELECT COUNT(*) FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE h.tag = ?').pluck().get(req.params.tag.toLowerCase());
  res.json({ tag: req.params.tag.toLowerCase(), total, items: gridTiles(rows), next: nextCursor(rows, GRID) });
});

posts.get('/mentions', (req, res) => {
  const q = str(req.query.q, 60).toLowerCase().replace(/[%_\\]/g, '');
  const users = db.prepare("SELECT 'user' AS type, id, username AS handle, display_name AS name FROM users WHERE disabled = 0 AND username LIKE ? LIMIT 5").all(`${q}%`) as any[];
  const adult = adultUnlocked(req) ? '' : 'AND c.adult = 0';
  const creators = db
    .prepare(`SELECT 'creator' AS type, c.id, c.handle, c.display_name AS name FROM creators c WHERE c.deleted = 0 ${adult} AND ${creatorScopeSql(scopeOf(req))} AND (c.handle LIKE ? OR c.display_name LIKE ?) LIMIT 8`)
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
  const [post] = hydratePosts([row], req.user!.id, req);
  post.can_edit = canEditPost(req.user!, row);
  res.json(post);
});

/**
 * May this caller name an 18+ creator as a destination? A scoped request never
 * sees 18+, and neither does a caller who has not unlocked it; to them an 18+
 * creator does not exist, so naming one must answer exactly like a name that
 * matches nothing (no "created as 18+" in the reply).
 */
const seesAdult = (req: Request): boolean => !isScoped(req) && adultUnlocked(req);

/** A creator by handle or alias, as far as this caller may see it. */
function findDestinationCreator(req: Request, name: string): { id: number; handle: string } | undefined {
  const c = findCreatorByName(name);
  if (!c || seesAdult(req)) return c;
  const adult = db.prepare('SELECT adult FROM creators WHERE id = ?').pluck().get(c.id);
  return adult ? undefined : c;
}

/** Asked again at insert time: the destination may have become 18+ meanwhile. */
function assertDestinationStillVisible(req: Request, creatorId: number | null, name: string): void {
  if (!creatorId || seesAdult(req)) return;
  if (db.prepare('SELECT adult FROM creators WHERE id = ?').pluck().get(creatorId)) throw new HttpError(400, `Unknown creator "${name}"`);
}

function resolveAuthor(req: Request, fields: Record<string, string>): Author {
  const creator = str(fields.creator, 80).trim().replace(/^@/, '');
  if (creator) {
    const c = findDestinationCreator(req, creator);
    if (!c) throw new HttpError(400, `Unknown creator "${creator}"`);
    return { creatorId: c.id };
  }
  return { userId: req.user!.id };
}

/**
 * A post inherits "general" from its creator, so putting a post under a creator
 * classified general is itself a classification: only a moderator (admin or the
 * profiles permission) may do it. Others keep posting under unclassified
 * creators, and may post under a general creator when the post is 18+, since an
 * 18+ post is never shown as general.
 */
function assertMayAssignCreator(req: Request, creatorId: number | null, currentCreatorId: number | null, adult: boolean): void {
  if (!creatorId || creatorId === currentCreatorId || adult) return;
  if (req.user!.role === 'admin' || can(req.user!, 'profiles')) return;
  const aud = db.prepare('SELECT audience FROM creators WHERE id = ?').pluck().get(creatorId);
  if (aud === 'general') throw new HttpError(403, 'Only a moderator can post under a creator classified general; mark the post 18+ or ask a moderator');
}

/** May this user classify (admin or the profiles permission)? */
const isClassifier = (req: Request): boolean => req.user!.role === 'admin' || can(req.user!, 'profiles');

/**
 * The audience a new upload is stored with. 18+ (`adult=1` or
 * `audience=adult`) needs nothing. `audience=general` needs a classifier.
 * Otherwise the post is unclassified; when its creator is classified general
 * and the uploader may not classify, the post is held for review, so it does
 * not inherit general. Asked again inside the insert transaction, because the
 * creator may be classified while the files are handled.
 */
function uploadAudience(req: Request, creatorId: number | null, wanted: string, adult: boolean): 'general' | 'unknown' | 'review' {
  if (wanted === 'general') {
    if (!isClassifier(req)) throw new HttpError(403, 'Only a moderator can classify posts');
    return 'general';
  }
  if (adult || !creatorId || isClassifier(req)) return 'unknown';
  const aud = db.prepare('SELECT audience FROM creators WHERE id = ?').pluck().get(creatorId);
  return aud === 'general' ? 'review' : 'unknown';
}

posts.post(
  '/posts',
  ah(async (req, res) => {
    const up = await parseUpload(req);
    try {
      if (up.files.length === 0) throw new HttpError(400, 'Add at least one image or video');
      const author = resolveAuthor(req, up.fields);
      const wanted = str(up.fields.audience, 20);
      if (wanted && !parseClassify(wanted)) throw new HttpError(400, 'audience must be general, unknown or adult');
      const adult = up.fields.adult === '1' || wanted === 'adult';
      const creatorId = author.creatorId ?? null;
      // Checked once before the files are handled, to fail fast, and again at insert.
      uploadAudience(req, creatorId, wanted, adult);
      const result = await createPost({
        author,
        uploaderId: req.user!.id,
        caption: str(up.fields.caption),
        adult,
        files: up.files.map((f) => ({ abs: f.abs, name: f.name })),
        beforeInsert: () => {
          assertDestinationStillVisible(req, creatorId, str(up.fields.creator, 80).trim().replace(/^@/, ''));
          return uploadAudience(req, creatorId, wanted, adult);
        },
      });
      if (!result.postId) throw new HttpError(400, `No usable media: ${result.rejected.map((r) => `${r.name} (${r.reason})`).join(', ')}`);
      notifyMentions(str(up.fields.caption), req.user!, result.postId, 'post');
      if (author.creatorId) notifyFollowers(author.creatorId, result.postId, req.user!.id);
      const stored = db.prepare('SELECT audience FROM posts WHERE id = ?').pluck().get(result.postId);
      // A scoped caller learns the new id and nothing about the classification;
      // it asks for the post in each scope like any other.
      if (isScoped(req)) res.status(201).json({ id: result.postId, rejected: result.rejected });
      else res.status(201).json({ id: result.postId, rejected: result.rejected, audience: adult ? 'adult' : stored === 'review' ? 'review' : currentPostAudience(result.postId) });
    } finally {
      await up.cleanup();
    }
  }),
);


/** Message for a PATCH whose post changed between its checks and its commit. */
const CHANGED = 'The post changed while it was being edited; reload it and try again';

/**
 * Everything a post edit is decided on: the post's 18+ flag, audience,
 * deletion and author, its creator's classification, its media (each id with
 * its missing flag), the destination creator's classification and deletion,
 * and the acting user's role, permissions and disabled flag. PATCH reads it
 * with its checks and compares it again before moving files and inside the
 * commit transaction.
 */
function editState(postId: number, destCreatorId: number | null, userId: number): string {
  const p = db
    .prepare(
      `SELECT p.adult, p.audience, p.deleted, p.creator_id, p.user_id, c.adult AS c_adult, c.audience AS c_audience, c.deleted AS c_deleted,
              (SELECT group_concat(m.id || ':' || m.missing, ',') FROM (SELECT id, missing FROM media WHERE post_id = p.id ORDER BY id) m) AS media
       FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE p.id = ?`,
    )
    .get(postId);
  const d = destCreatorId ? db.prepare('SELECT adult, audience, deleted FROM creators WHERE id = ?').get(destCreatorId) : null;
  const u = db.prepare('SELECT role, permissions, disabled FROM users WHERE id = ?').get(userId);
  return JSON.stringify([p ?? null, d ?? null, u ?? null]);
}

posts.patch(
  '/posts/:id',
  ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = loadVisiblePost(req, id, true);
    if (!row) throw new HttpError(404, 'Post not found');
    if (!canEditPost(req.user!, row)) throw new HttpError(403, 'Forbidden');
    const body = req.body ?? {};
    // Validate and authorize every requested change before writing anything, so a
    // refused part never leaves the others half applied (or mentions already sent).
    // Anyone who may edit the post may mark it 18+. Lifting 18+ or setting the
    // audience is classification and needs the profiles permission (or admin).
    const classifier = req.user!.role === 'admin' || can(req.user!, 'profiles');
    if (typeof body.adult === 'boolean' && !body.adult && row.adult && !classifier) throw new HttpError(403, 'Only a moderator can lift 18+');
    const audience = body.audience === undefined ? null : parseClassify(body.audience);
    if (body.audience !== undefined && !audience) throw new HttpError(400, 'audience must be general, unknown or adult');
    if (audience && audience !== 'adult' && audience !== row.audience && !classifier) throw new HttpError(403, 'Only a moderator can classify posts');
    let author: Author | null = null;
    if (body.author && typeof body.author === 'object') {
      if (body.author.self) author = { userId: req.user!.id };
      else {
        const c = findDestinationCreator(req, str(body.author.creator, 80));
        if (!c) throw new HttpError(400, 'Unknown creator');
        author = { creatorId: c.id };
      }
      assertMayAssignCreator(req, author.creatorId ?? null, row.creator_id, !!row.adult || body.adult === true);
    }
    let toRemove: number[] = [];
    if (Array.isArray(body.removeMedia) && body.removeMedia.length) {
      const remaining = db.prepare('SELECT COUNT(*) FROM media WHERE post_id = ? AND missing = 0').pluck().get(id) as number;
      toRemove = (body.removeMedia as unknown[]).map(Number).filter(Number.isInteger);
      if (toRemove.length >= remaining) throw new HttpError(400, 'A post needs at least one media item; delete the post instead');
    }

    // Resubmitting the current author is no reassignment.
    if (author && (author.creatorId ? author.creatorId === row.creator_id : !row.creator_id && author.userId === row.user_id)) author = null;
    // Every check above was made against this state, read in the same
    // synchronous step as `row`. Files move first (slow, outside any
    // transaction); then every write of this request lands in one transaction
    // that first compares the state again. If anything it rests on changed
    // meanwhile (18+ or audience of the post or its creator, an importer hold,
    // the destination's classification or deletion, the media list), the
    // request writes nothing, gets 409, and the files go back to the author
    // the post has now. This holds for moderators too: a stale request never
    // overwrites a newer classification.
    const destId = author?.creatorId ?? null;
    const before = editState(id, destId, req.user!.id);
    const caption = typeof body.caption === 'string' ? str(body.caption) : null;
    // Media ids this request moved to a holder post (client ids of other posts never count).
    const removed: number[] = [];
    const commit = db.transaction((): string | null => {
      if (editState(id, destId, req.user!.id) !== before) return CHANGED;
      // A post inherits 18+ from its creator; moving it keeps that restriction on
      // the post itself. Only a moderator who saw the 18+ creator may lift it.
      const keepAdult = !!author && !!row.c_adult && !classifier;
      if (author) db.prepare('UPDATE posts SET creator_id = ?, user_id = ? WHERE id = ?').run(author.creatorId ?? null, author.creatorId ? null : author.userId, id);
      if (caption !== null) {
        db.prepare('UPDATE posts SET caption = ? WHERE id = ?').run(caption, id);
        setPostHashtags(id, caption);
      }
      // A new caption or a new author changes which creators the post mentions
      // (the post's own creator is never one of them).
      if (caption !== null || author) linkMentionsSafely(id);
      if (typeof body.adult === 'boolean') db.prepare('UPDATE posts SET adult = ? WHERE id = ?').run(body.adult ? 1 : 0, id);
      if (keepAdult) db.prepare('UPDATE posts SET adult = 1 WHERE id = ?').run(id);
      // 'adult' sets the 18+ flag; general/unknown only change the audience and never clear 18+.
      if (audience === 'adult') db.prepare('UPDATE posts SET adult = 1 WHERE id = ?').run(id);
      else if (audience) db.prepare('UPDATE posts SET audience = ? WHERE id = ?').run(audience, id);
      if (toRemove.length) {
        // Removed media move to a new hidden, deleted post so the file and its row
        // stay recoverable. The holder keeps the post's owner and takes the
        // stricter classification of before this edit (`row`, unchanged up to
        // this transaction) and after it: 18+ if either was, general only if both were.
        const cur = db
          .prepare('SELECT p.adult, p.audience, c.adult AS c_adult, c.audience AS c_audience FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE p.id = ?')
          .get(id) as { adult: number; audience: string; c_adult: number | null; c_audience: string | null };
        const was = effectiveAudience(row);
        const is = effectiveAudience(cur);
        const adult = was === 'adult' || is === 'adult' ? 1 : 0;
        // The holder keeps the original creator, so 'unknown' would let it inherit
        // general from that creator. It does so only when the post was shown as
        // general both before and after; otherwise (held for review, or not
        // general on either side) it is held for review itself.
        const holderAudience =
          row.audience === 'general' && cur.audience === 'general' ? 'general' : was === 'general' && is === 'general' ? 'unknown' : 'review';
        const t = now();
        const holder = db
          .prepare(
            'INSERT INTO posts (creator_id, user_id, uploader_id, caption, created_at, imported_at, deleted, deleted_at, adult, audience) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
          )
          .run(row.creator_id, row.user_id, req.user!.id, `Removed from post ${id}`, row.created_at, t, t, adult, holderAudience);
        const upd = db.prepare('UPDATE media SET post_id = ? WHERE id = ? AND post_id = ?');
        for (const mid of toRemove) if (upd.run(Number(holder.lastInsertRowid), mid, id).changes === 1) removed.push(mid);
      }
      return null;
    });
    let refusal: string | null;
    if (author) {
      const dest = author;
      refusal = await withMoveLock(async () => {
        // Waiting for the lock may have taken a while: nothing moves on a stale decision.
        if (editState(id, destId, req.user!.id) !== before) return CHANGED;
        const moved: number[] = [];
        let r: string | null;
        try {
          await moveMediaToAuthor([id], dest, moved);
          r = commit();
        } catch (err) {
          await returnMediaHome(moved);
          throw err;
        }
        // Refused: this request wrote nothing, and every file it moved goes to
        // the author of the post that owns it now (a removed item may belong
        // to a holder post by now). Accepted: items this request removed go to
        // their holder's author.
        await returnMediaHome(r ? moved : removed);
        return r;
      });
    } else refusal = commit();
    if (refusal) throw new HttpError(refusal === CHANGED ? 409 : 404, refusal);
    if (caption !== null) notifyMentions(caption, req.user!, id, 'post');
    if (Array.isArray(body.order)) {
      const upd = db.prepare('UPDATE media SET position = ? WHERE id = ? AND post_id = ?');
      db.transaction(() => (body.order as unknown[]).forEach((mid, i) => upd.run(i, Number(mid), id)))();
    }
    indexPost(id);
    const after = loadVisiblePost(req, id, true);
    // Reclassifying can move a post out of the caller's scope; say so instead of failing.
    if (!after) {
      res.json({ id, out_of_scope: true, can_edit: true });
      return;
    }
    const [post] = hydratePosts([after], req.user!.id, req);
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
    // A new item inherits the post's audience. On a post shown as general that
    // would classify it, so only a moderator may add to such a post.
    const moderator = req.user!.role === 'admin' || can(req.user!, 'profiles');
    if (effectiveAudience(row) === 'general' && !moderator) {
      throw new HttpError(403, 'Only a moderator can add media to a post classified general');
    }
    const up = await parseUpload(req);
    try {
      // Asked again at insert time: the post may become general while the upload streams.
      const r = await addMediaToPost(id, up.files.map((f) => ({ abs: f.abs, name: f.name })), false, () => moderator || currentPostAudience(id) !== 'general');
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
  // The backfill skips deleted posts, so a restored one gets its mentions now.
  linkMentionsSafely(id);
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
  if (isScoped(req) && !loadVisiblePost(req, id)) throw new HttpError(404, 'Post not found');
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

/** Deletes a comment through its post, so a scoped caller can only reach comments on posts it may see. */
posts.delete('/posts/:id/comments/:cid', (req, res) => {
  const id = intParam(req.params.id);
  if (!loadVisiblePost(req, id)) throw new HttpError(404, 'Post not found');
  const c = db.prepare('SELECT user_id FROM comments WHERE id = ? AND post_id = ?').get(intParam(req.params.cid), id) as { user_id: number } | undefined;
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'Forbidden');
  db.prepare('DELETE FROM comments WHERE id = ?').run(intParam(req.params.cid));
  res.json({ ok: true });
});

posts.delete('/comments/:id', (req, res) => {
  const id = intParam(req.params.id);
  const c = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(id) as { user_id: number } | undefined;
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'Forbidden');
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  res.json({ ok: true });
});
