import { Router, type Request } from 'express';
import { db, now } from '../db/index.js';
import { adultUnlocked, can, requirePerm } from '../auth.js';
import { ah, HttpError, str } from '../http.js';
import { parseCursor, cursorSql, nextCursor, gridTiles, POST_FROM, visible } from '../views.js';
import { parseUpload } from '../media/upload.js';
import { APP_DIRS, isReservedName, mediaRel, sniffFile, uniqueTarget, moveFile, validateHandle } from '../media/files.js';
import { createCreator, MediaRejected, moveMediaToAuthor, reindexCreator } from '../library.js';
import { notify } from '../notify.js';

export const creators = Router();

function loadCreator(req: Request, handle: string): any {
  const c = db.prepare('SELECT * FROM creators WHERE handle = ? AND deleted = 0').get(handle.toLowerCase()) as any;
  if (!c) throw new HttpError(404, 'Profile not found');
  if (c.adult && !adultUnlocked(req)) throw new HttpError(404, 'Profile not found');
  return c;
}

function creatorJson(req: Request, c: any) {
  const counts = db
    .prepare(`SELECT COUNT(*) AS posts FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE p.creator_id = ? AND ${visible(req)}`)
    .get(c.id) as any;
  const aliases = db.prepare('SELECT alias FROM creator_aliases WHERE creator_id = ? ORDER BY alias').pluck().all(c.id);
  const followers = db.prepare('SELECT COUNT(*) FROM follows WHERE creator_id = ?').pluck().get(c.id);
  const following = !!db.prepare('SELECT 1 FROM follows WHERE creator_id = ? AND user_id = ?').get(c.id, req.user!.id);
  let links: unknown[] = [];
  try {
    links = JSON.parse(c.links);
  } catch {
    links = [];
  }
  const full = can(req.user, 'profiles');
  return {
    id: c.id,
    handle: c.handle,
    display_name: c.display_name,
    bio: c.bio,
    links,
    aliases,
    avatar: `/m/ca/${c.id}`,
    banner: `/m/cb/${c.id}`,
    has_avatar: !!c.avatar_path,
    has_banner: !!c.banner_path,
    adult: !!c.adult,
    post_count: counts.posts,
    follower_count: followers,
    following,
    ig_handle: c.ig_handle,
    tiktok_handle: c.tiktok_handle,
    ig_autopoll: !!c.ig_autopoll,
    tiktok_autopoll: !!c.tiktok_autopoll,
    last_sync_at: full ? c.last_sync_at : undefined,
    last_sync_result: full ? c.last_sync_result : undefined,
    can_manage: full,
  };
}

creators.get('/creators', (req, res) => {
  const q = str(req.query.q, 80).trim().toLowerCase().replace(/[%_\\]/g, '');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = 60;
  const adult = adultUnlocked(req) ? '' : 'AND c.adult = 0';
  const adultPost = adultUnlocked(req) ? '' : 'AND p.adult = 0';
  const filter = q ? "AND (c.handle LIKE ? OR c.display_name LIKE ? OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = c.id AND a.alias LIKE ?))" : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const rows = db
    .prepare(
      `SELECT c.id, c.handle, c.display_name, c.adult, COALESCE(pc.n, 0) AS post_count, pc.latest
       FROM creators c
       LEFT JOIN (SELECT p.creator_id, COUNT(*) AS n, MAX(p.created_at) AS latest FROM posts p WHERE p.deleted = 0 ${adultPost} GROUP BY p.creator_id) pc ON pc.creator_id = c.id
       WHERE c.deleted = 0 ${adult} ${filter}
       ORDER BY (COALESCE(pc.n, 0) > 0) DESC, pc.latest DESC, c.handle
       LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(...args) as any[];
  res.json({
    items: rows.map((r) => ({ id: r.id, handle: r.handle, display_name: r.display_name, adult: !!r.adult, post_count: r.post_count, avatar: `/m/ca/${r.id}` })),
    next: rows.length === limit ? offset + limit : null,
  });
});

creators.post('/creators', requirePerm('profiles'), (req, res) => {
  const handle = str(req.body?.handle, 80).trim().toLowerCase().replace(/^@/, '');
  try {
    const id = createCreator(handle, { displayName: str(req.body?.display_name, 120), adult: !!req.body?.adult });
    res.status(201).json({ id, handle });
  } catch (err) {
    if (err instanceof MediaRejected) throw new HttpError(400, err.message);
    throw err;
  }
});

creators.get('/creators/:handle', (req, res) => {
  res.json(creatorJson(req, loadCreator(req, req.params.handle)));
});

creators.get('/creators/:handle/posts', (req, res) => {
  const c = loadCreator(req, req.params.handle);
  const cur = cursorSql(parseCursor(req.query.cursor));
  const limit = 36;
  const rows = db
    .prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE p.creator_id = ? AND ${visible(req)} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`)
    .all(c.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, limit) });
});

function cleanLinks(v: unknown): { label: string; url: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 10)
    .map((l: any) => ({ label: str(l?.label, 60).trim(), url: str(l?.url, 500).trim() }))
    .filter((l) => /^https?:\/\//i.test(l.url));
}

creators.patch('/creators/:handle', (req, res) => {
  const c = loadCreator(req, req.params.handle);
  const b = req.body ?? {};
  const manage = can(req.user, 'profiles');
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (typeof b.display_name === 'string') set('display_name', str(b.display_name, 120));
  if (typeof b.bio === 'string') set('bio', str(b.bio, 2000));
  if (b.links !== undefined) set('links', JSON.stringify(cleanLinks(b.links)));
  const handleField = (v: unknown) => {
    const h = str(v, 80).trim().replace(/^@/, '').toLowerCase();
    if (h && !/^[a-z0-9._-]{1,60}$/.test(h)) throw new HttpError(400, `Invalid source handle "${h}"`);
    return h || null;
  };
  if (manage) {
    if (b.ig_handle !== undefined) set('ig_handle', handleField(b.ig_handle));
    if (b.tiktok_handle !== undefined) set('tiktok_handle', handleField(b.tiktok_handle));
    if (typeof b.ig_autopoll === 'boolean') set('ig_autopoll', b.ig_autopoll ? 1 : 0);
    if (typeof b.tiktok_autopoll === 'boolean') set('tiktok_autopoll', b.tiktok_autopoll ? 1 : 0);
    if (typeof b.adult === 'boolean') set('adult', b.adult ? 1 : 0);
  } else if (['ig_handle', 'tiktok_handle', 'ig_autopoll', 'tiktok_autopoll', 'adult'].some((k) => b[k] !== undefined)) {
    throw new HttpError(403, 'Changing sync sources or the 18+ flag needs the profiles permission');
  }
  db.transaction(() => {
    if (sets.length) db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = ?`).run(...args, c.id);
    if (Array.isArray(b.aliases)) {
      const aliases = [...new Set((b.aliases as unknown[]).map((a) => str(a, 60).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
      for (const a of aliases) {
        if (a === c.handle) continue;
        if (!/^[a-z0-9._-]{1,60}$/.test(a)) throw new HttpError(400, `Invalid alias "${a}"`);
        const other = db.prepare('SELECT id FROM creators WHERE handle = ? AND id != ?').get(a, c.id);
        const taken = db.prepare('SELECT creator_id FROM creator_aliases WHERE alias = ? AND creator_id != ?').get(a, c.id);
        if (other || taken) throw new HttpError(400, `"${a}" already belongs to another profile`);
      }
      db.prepare('DELETE FROM creator_aliases WHERE creator_id = ?').run(c.id);
      const ins = db.prepare('INSERT INTO creator_aliases (alias, creator_id) VALUES (?, ?)');
      for (const a of aliases) if (a !== c.handle) ins.run(a, c.id);
    }
  })();
  reindexCreator(c.id);
  res.json(creatorJson(req, db.prepare('SELECT * FROM creators WHERE id = ?').get(c.id)));
});

async function storeImage(req: Request, dir: string, prefix: string): Promise<string> {
  const up = await parseUpload(req);
  try {
    const f = up.files[0];
    if (!f) throw new HttpError(400, 'No file');
    const s = await sniffFile(f.abs);
    if (!s || s.kind !== 'image') throw new HttpError(400, 'Not an image');
    const dest = await uniqueTarget(dir, `${prefix}_${Date.now()}`, s.ext);
    await moveFile(f.abs, dest);
    return mediaRel(dest);
  } finally {
    await up.cleanup();
  }
}

for (const kind of ['avatar', 'banner'] as const) {
  creators.post(
    `/creators/:handle/${kind}`,
    ah(async (req, res) => {
      const c = loadCreator(req, req.params.handle);
      const rel = await storeImage(req, kind === 'avatar' ? APP_DIRS.avatars : APP_DIRS.banners, `c${c.id}`);
      // The previous picture is kept on disk; the cleaning job may remove it once nothing references it.
      db.prepare(`UPDATE creators SET ${kind}_path = ? WHERE id = ?`).run(rel, c.id);
      res.json({ ok: true, url: `/m/${kind === 'avatar' ? 'ca' : 'cb'}/${c.id}?v=${Date.now()}` });
    }),
  );
}

creators.delete('/creators/:handle', requirePerm('profiles'), (req, res) => {
  const handle = req.params.handle.toLowerCase();
  if (isReservedName(handle) || validateHandle(handle)) throw new HttpError(400, `"${handle}" is a reserved name and cannot be deleted`);
  const c = loadCreator(req, handle);
  // Soft delete only: rows get a flag, files stay where they are.
  db.transaction(() => {
    db.prepare('UPDATE creators SET deleted = 1, ig_autopoll = 0, tiktok_autopoll = 0 WHERE id = ?').run(c.id);
    db.prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE creator_id = ? AND deleted = 0').run(now(), c.id);
  })();
  reindexCreator(c.id);
  res.json({ ok: true });
});

creators.post('/creators/:handle/restore', requirePerm('profiles'), (req, res) => {
  const c = db.prepare('SELECT id, deleted FROM creators WHERE handle = ?').get(req.params.handle.toLowerCase()) as any;
  if (!c) throw new HttpError(404, 'Profile not found');
  db.transaction(() => {
    db.prepare('UPDATE creators SET deleted = 0 WHERE id = ?').run(c.id);
    db.prepare('UPDATE posts SET deleted = 0, deleted_at = NULL WHERE creator_id = ? AND deleted = 1').run(c.id);
  })();
  reindexCreator(c.id);
  res.json({ ok: true });
});

creators.post('/creators/:handle/follow', (req, res) => {
  const c = loadCreator(req, req.params.handle);
  db.prepare('INSERT OR IGNORE INTO follows (user_id, creator_id, created_at) VALUES (?, ?, ?)').run(req.user!.id, c.id, now());
  res.json({ following: true });
});

creators.delete('/creators/:handle/follow', (req, res) => {
  const c = loadCreator(req, req.params.handle);
  db.prepare('DELETE FROM follows WHERE user_id = ? AND creator_id = ?').run(req.user!.id, c.id);
  res.json({ following: false });
});

/** Merges "from" into "into": posts, files, aliases, follows and sync handles move over. */
creators.post(
  '/creators-merge',
  requirePerm('profiles'),
  ah(async (req, res) => {
    const from = loadCreator(req, str(req.body?.from, 80));
    const into = loadCreator(req, str(req.body?.into, 80));
    if (from.id === into.id) throw new HttpError(400, 'Pick two different profiles');
    const postIds = db.prepare('SELECT id FROM posts WHERE creator_id = ?').pluck().all(from.id) as number[];
    await moveMediaToAuthor(postIds, { creatorId: into.id });
    db.transaction(() => {
      db.prepare('UPDATE posts SET creator_id = ? WHERE creator_id = ?').run(into.id, from.id);
      db.prepare('UPDATE creator_aliases SET creator_id = ? WHERE creator_id = ?').run(into.id, from.id);
      db.prepare('INSERT OR IGNORE INTO creator_aliases (alias, creator_id) VALUES (?, ?)').run(from.handle, into.id);
      db.prepare('INSERT OR IGNORE INTO follows (user_id, creator_id, created_at) SELECT user_id, ?, created_at FROM follows WHERE creator_id = ?').run(into.id, from.id);
      db.prepare('DELETE FROM follows WHERE creator_id = ?').run(from.id);
      db.prepare(
        `UPDATE creators SET
           ig_handle = COALESCE(ig_handle, ?), tiktok_handle = COALESCE(tiktok_handle, ?),
           avatar_path = COALESCE(avatar_path, ?), banner_path = COALESCE(banner_path, ?),
           bio = CASE WHEN bio = '' THEN ? ELSE bio END, adult = MAX(adult, ?)
         WHERE id = ?`,
      ).run(from.ig_handle, from.tiktok_handle, from.avatar_path, from.banner_path, from.bio, from.adult, into.id);
      // The emptied profile keeps its row (soft-deleted), but its handle is freed to live on as an alias.
      db.prepare("UPDATE creators SET deleted = 1, ig_autopoll = 0, tiktok_autopoll = 0, handle = handle || '~merged' || id WHERE id = ?").run(from.id);
    })();
    reindexCreator(into.id);
    for (const uid of db.prepare('SELECT user_id FROM follows WHERE creator_id = ?').pluck().all(into.id) as number[]) {
      notify({ userId: uid, kind: 'system', creatorId: into.id, text: `${from.handle} was merged into ${into.handle}`, url: `/u/${into.handle}` });
    }
    res.json({ ok: true, moved: postIds.length, into: into.handle });
  }),
);

creators.get('/creators-deleted', requirePerm('profiles'), (_req, res) => {
  res.json({ items: db.prepare("SELECT id, handle, display_name FROM creators WHERE deleted = 1 AND handle NOT LIKE '%~merged%' ORDER BY handle").all() });
});

