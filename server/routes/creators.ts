import { Router, type Request } from 'express';
import { db, now } from '../db/index.js';
import { adultUnlocked, can, requirePerm } from '../auth.js';
import { ah, HttpError, str } from '../http.js';
import { creatorScopeSql, parseClassify, refuseScoped, scopeOf, scopeSql } from '../audience.js';
import { parseCursor, cursorSql, nextCursor, gridTiles, mentionOriginVisibleSql, mentionTargetSql, POST_FROM, visible } from '../views.js';
import { parseUpload } from '../media/upload.js';
import { APP_DIRS, isReservedName, mediaRel, placeFile, sniffFile, validateHandle } from '../media/files.js';
import { createCreator, findCreatorByName, MediaRejected, moveMediaToAuthor, reindexCreator, returnMediaHome, withMoveLock } from '../library.js';
import { notify } from '../notify.js';

export const creators = Router();

// General scope only: a creator nobody classified general opens as a limited
// profile when a post the scope shows mentions it, and it has no 18+ post.
// Shared by the profile routes and creator-identities, so the Grabbit
// gateway's 18+ check can resolve every creator a limited profile or a mention
// link names.
function limitedReachable(req: Request, creatorId: number): boolean {
  if (scopeOf(req) !== 'general') return false;
  return !!db
    .prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${mentionTargetSql(req)} AND EXISTS (SELECT 1 FROM post_mentions pm JOIN posts p ON p.id = pm.post_id LEFT JOIN creators c ON c.id = p.creator_id LEFT JOIN users u ON u.id = p.user_id WHERE pm.creator_id = ? AND ${visible(req)})`)
    .get(creatorId, creatorId);
}

// allowLimited: only the read routes (profile, posts, mentioned) accept a limited
// profile; every write (edit, pictures, follow, merge, delete) refuses it with 404.
function loadCreator(req: Request, handle: string, { allowLimited = false } = {}): any {
  const c = db.prepare('SELECT * FROM creators WHERE handle = ? AND deleted = 0').get(handle.toLowerCase()) as any;
  if (!c) throw new HttpError(404, 'Profile not found');
  if (c.adult && !adultUnlocked(req)) throw new HttpError(404, 'Profile not found');
  const scope = scopeOf(req);
  if (scope && !db.prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${creatorScopeSql(scope)}`).get(c.id)) {
    // The limited profile names the handle and nothing else the creator owns
    // (no bio, links, aliases or picture), and lists only posts of the scope.
    if (!(allowLimited && limitedReachable(req, c.id))) throw new HttpError(404, 'Profile not found');
    c.limited = true;
  }
  // A creator made for an @name, with no post of its own, exists in a scope
  // only through a post of that scope that mentions it.
  if (scope && !db.prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${mentionOriginVisibleSql(req)}`).get(c.id)) throw new HttpError(404, 'Profile not found');
  return c;
}

function creatorJson(req: Request, c: any) {
  const counts = db
    .prepare(`SELECT COUNT(*) AS posts FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE p.creator_id = ? AND ${visible(req)}`)
    .get(c.id) as any;
  const mentioned = db
    .prepare(`SELECT COUNT(*) FROM post_mentions pm ${POST_FROM.replace('FROM posts p', 'JOIN posts p ON p.id = pm.post_id')} WHERE pm.creator_id = ? AND ${visible(req)}`)
    .pluck()
    .get(c.id) as number;
  if (c.limited) {
    return {
      id: c.id,
      handle: c.handle,
      // A creator made for an @name may carry that name as written, and nothing else.
      display_name: c.origin === 'mention' ? c.display_name : '',
      bio: '',
      links: [],
      aliases: [],
      avatar: `/m/ca/${c.id}`,
      banner: `/m/cb/${c.id}`,
      has_avatar: false,
      has_banner: false,
      adult: false,
      // The lane it is shown in; the creator itself stays unclassified.
      audience: 'general',
      limited: true,
      post_count: counts.posts,
      mentioned_count: mentioned,
      follower_count: db.prepare('SELECT COUNT(*) FROM follows WHERE creator_id = ?').pluck().get(c.id),
      following: !!db.prepare('SELECT 1 FROM follows WHERE creator_id = ? AND user_id = ?').get(c.id, req.user!.id),
      ig_handle: null,
      tiktok_handle: null,
      ig_autopoll: false,
      tiktok_autopoll: false,
      can_manage: false,
    };
  }
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
    audience: c.adult ? 'adult' : c.audience === 'general' ? 'general' : 'unknown',
    post_count: counts.posts,
    mentioned_count: mentioned,
    origin: c.origin ?? null,
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
  const q = str(req.query.q, 80).trim().toLowerCase();
  // LIKE wildcards are escaped, not removed: handles are full of underscores.
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = 60;
  const adult = adultUnlocked(req) ? '' : 'AND c.adult = 0';
  const adultPost = adultUnlocked(req) ? '' : 'AND p.adult = 0';
  const scope = scopeOf(req);
  // Scoped counts include only posts the scope can see (the derived table joins its own creators row).
  const scopePost = scope ? `AND ${scopeSql(scope)}` : '';
  // A creator made for an @name owns nothing to browse or classify until it
  // has posts of its own; it is listed only when searched for.
  const mentionOnly = q ? '' : "AND NOT (c.origin = 'mention' AND NOT EXISTS (SELECT 1 FROM posts po WHERE po.creator_id = c.id))";
  const filter = q
    ? "AND (c.handle LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = c.id AND a.alias LIKE ? ESCAPE '\\'))"
    : '';
  const args = q ? [like, like, like] : [];
  const rows = db
    .prepare(
      `SELECT c.id, c.handle, c.display_name, c.adult, c.audience, COALESCE(pc.n, 0) AS post_count, pc.latest
       FROM creators c
       LEFT JOIN (SELECT p.creator_id, COUNT(*) AS n, MAX(p.created_at) AS latest FROM posts p LEFT JOIN creators c ON c.id = p.creator_id
                  WHERE p.deleted = 0 ${adultPost} ${scopePost} GROUP BY p.creator_id) pc ON pc.creator_id = c.id
       WHERE c.deleted = 0 ${adult} AND ${creatorScopeSql(scope)} AND ${mentionOriginVisibleSql(req)} ${filter} ${mentionOnly}
       ORDER BY (COALESCE(pc.n, 0) > 0) DESC, pc.latest DESC, c.handle
       LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(...args) as any[];
  // samples=1 adds up to three recent tiles per creator (the review lane classifies from them).
  const samples = req.query.samples === '1';
  const sampleStmt = samples
    ? db.prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE p.creator_id = ? AND ${visible(req)} ORDER BY p.created_at DESC, p.id DESC LIMIT 3`)
    : null;
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      display_name: r.display_name,
      adult: !!r.adult,
      audience: r.adult ? 'adult' : r.audience === 'general' ? 'general' : 'unknown',
      post_count: r.post_count,
      avatar: `/m/ca/${r.id}`,
      ...(sampleStmt ? { samples: gridTiles(sampleStmt.all(r.id) as any[]) } : {}),
    })),
    next: rows.length === limit ? offset + limit : null,
  });
});

/**
 * Classifies creators in bulk: { handles: string[], audience: general|unknown|adult }.
 * 'adult' sets the 18+ flag. An 18+ creator is never downgraded here; it is
 * reported as skipped (as "not found" to a scoped caller, which may not know it exists).
 */
/**
 * Other names a creator is known by: aliases, the Instagram and TikTok sync
 * handles, and accounts named by its profile links on known sites. Grabbit's
 * gateway uses them to match a creator against its own 18+ profiles under any
 * identity, not only the Elitogram handle. Lower-case, without '@'.
 */
const LINK_SITES: [RegExp, RegExp][] = [
  [/^(www\.)?instagram\.com$/, /^\/([a-z0-9._]{1,30})\/?$/],
  [/^(www\.|m\.)?tiktok\.com$/, /^\/@([a-z0-9._]{1,30})\/?$/],
  [/^(www\.|mobile\.)?(x|twitter)\.com$/, /^\/([a-z0-9_]{1,15})\/?$/],
  [/^(www\.)?onlyfans\.com$/, /^\/([a-z0-9._-]{1,50})\/?$/],
  [/^(www\.)?fansly\.com$/, /^\/([a-z0-9._-]{1,50})(\/posts)?\/?$/],
  [/^(www\.|old\.)?reddit\.com$/, /^\/(?:u|user)\/([a-z0-9_-]{1,30})\/?$/],
  [/^(www\.|m\.)?youtube\.com$/, /^\/@([a-z0-9._-]{1,100})\/?$/],
];
function linkHandles(raw: string | null): string[] {
  let list: unknown[] = [];
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const l of Array.isArray(list) ? list : []) {
    let u: URL;
    try {
      u = new URL(String((l as any)?.url ?? ''));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    for (const [h, p] of LINK_SITES) {
      const m = h.test(host) ? p.exec(u.pathname.toLowerCase()) : null;
      if (m) out.push(m[1]);
    }
  }
  return out;
}

creators.get('/creator-identities', (req, res) => {
  // `h` names creators, `a` names accounts. The two namespaces are separate (a
  // creator and an account may share a handle), so each is answered on its own
  // and a caller never reads one as the other.
  const list = (v: unknown) =>
    ([] as unknown[])
      .concat(v ?? [])
      .map((x) => String(x).trim().toLowerCase())
      .filter((x) => /^[a-z0-9._~-]{1,100}$/.test(x))
      .slice(0, 100);
  const handles = list(req.query.h);
  const usernames = list(req.query.a);
  const scope = scopeOf(req);
  // Only creators the caller could see: an identity list is still a fact about a
  // profile. In a scope that is the creator's own profile, or any post by the
  // creator the scope can see (a post held in review under a creator classified
  // general shows in the unknown scope while its creator does not). A deleted
  // post counts only for those who may see it (its uploader, its account
  // author, or a moderator), as with its media.
  const moderator = req.user!.role === 'admin' || can(req.user!, 'profiles');
  const deletedOk = moderator ? '1=1' : '(p.uploader_id = @me OR p.user_id = @me)';
  const inScope = scope
    ? `AND c.adult = 0 AND ${mentionOriginVisibleSql(req)} AND (${creatorScopeSql(scope)} OR EXISTS (SELECT 1 FROM posts p WHERE p.creator_id = c.id AND p.adult = 0 AND (p.deleted = 0 OR ${deletedOk}) AND ${scopeSql(scope)}))`
    : adultUnlocked(req)
      ? ''
      : 'AND c.adult = 0';
  const one = db.prepare(`SELECT c.id, c.handle, c.ig_handle, c.tiktok_handle, c.links FROM creators c WHERE c.handle = @h AND c.deleted = 0 ${inScope}`);
  const account = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const aliases = db.prepare('SELECT alias FROM creator_aliases WHERE creator_id = ?').pluck();
  const items: Record<string, string[]> = {};
  // A creator outside the scope that opens there as a limited profile (general
  // only) is answered too, because the limited profile and the mention links
  // name it. The limited profile hides the creator's other names, so this
  // answer may list only the one name the limited profile shows itself (the
  // @name as written, for a creator made from a mention: `_bs.tv` for
  // `u-bs.tv`). A creator with any other name gets no answer, which the
  // gateway's 18+ check treats as 18+ (closed).
  const outside = db.prepare('SELECT c.id, c.handle, c.ig_handle, c.tiktok_handle, c.links, c.origin, c.display_name FROM creators c WHERE c.handle = ? AND c.deleted = 0 AND c.adult = 0');
  const namesOf = (c: any): string[] => {
    const names = new Set<string>();
    for (const n of [...(aliases.all(c.id) as string[]), c.ig_handle, c.tiktok_handle, ...linkHandles(c.links)]) {
      const v = String(n ?? '').trim().replace(/^@/, '').toLowerCase();
      if (v && v !== c.handle) names.add(v.slice(0, 100));
    }
    return [...names];
  };
  // Which answer a creator gets is decided by the profile the caller can open,
  // before the ordinary branch: in the general scope a creator not classified
  // general opens at most as a limited profile, so it gets the limited name
  // projection even when an owned post (a deleted one included) makes it
  // eligible. Eligibility and the names returned are separate questions.
  const generalProfile = db.prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${creatorScopeSql('general')}`);
  const limitedNames = (m: any): string[] | null => {
    const shown = m.origin === 'mention' ? String(m.display_name ?? '').trim().replace(/^@/, '').toLowerCase() : '';
    const names = namesOf(m);
    return names.every((n) => n === shown) ? names : null;
  };
  for (const h of [...new Set(handles)]) {
    const c = one.get({ h, me: req.user!.id }) as any;
    if (scope === 'general') {
      const m = outside.get(h) as any;
      if (!m) continue;
      if (generalProfile.get(m.id)) {
        if (c) items[c.handle] = namesOf(c);
        continue;
      }
      // Limited at most: eligible through the ordinary branch or as a limited
      // profile, answered with the limited projection either way.
      if (!c && !limitedReachable(req, m.id)) continue;
      const names = limitedNames(m);
      if (names) items[m.handle] = names;
      continue;
    }
    if (c) items[c.handle] = namesOf(c);
  }
  // Accounts have no other names; listed when they exist, whatever creator
  // shares the name.
  const accounts = [...new Set(usernames)].filter((u) => account.get(u));
  res.set('Cache-Control', 'private, no-store').json({ items, accounts });
});

creators.post('/creators-classify', requirePerm('profiles'), (req, res) => {
  const audience = parseClassify(req.body?.audience);
  if (!audience) throw new HttpError(400, 'audience must be general, unknown or adult');
  const raw = Array.isArray(req.body?.handles) ? (req.body.handles as unknown[]) : [];
  const handles = [...new Set(raw.map((h) => str(h, 80).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (handles.length === 0 || handles.length > 500) throw new HttpError(400, 'Send 1 to 500 handles');
  const scoped = !!scopeOf(req);
  const updated: string[] = [];
  const skipped: { handle: string; reason: string }[] = [];
  // In a scope, a creator made for an @name that the scope shows no post of
  // does not exist there (mentionOriginVisibleSql): naming it, by handle or by
  // an alias, answers "not found" like an unused name and changes nothing.
  const visibleHere = db.prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${mentionOriginVisibleSql(req)}`);
  db.transaction(() => {
    for (const h of handles) {
      const hit = findCreatorByName(h);
      const found = hit ? (db.prepare('SELECT id, handle, adult, audience FROM creators WHERE id = ? AND deleted = 0').get(hit.id) as any) : undefined;
      const c = found && (!scoped || visibleHere.get(found.id)) ? found : undefined;
      if (!c || (c.adult && scoped)) {
        skipped.push({ handle: h, reason: 'not found' });
        continue;
      }
      if (audience === 'adult') {
        db.prepare('UPDATE creators SET adult = 1 WHERE id = ?').run(c.id);
      } else if (c.adult) {
        skipped.push({ handle: h, reason: '18+ profiles are not downgraded' });
        continue;
      } else {
        db.prepare('UPDATE creators SET audience = ? WHERE id = ?').run(audience, c.id);
      }
      updated.push(c.handle);
    }
  })();
  // The search index holds text only, so a new audience needs no reindex.
  res.json({ audience, updated, skipped });
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
  res.json(creatorJson(req, loadCreator(req, req.params.handle, { allowLimited: true })));
});

creators.get('/creators/:handle/posts', (req, res) => {
  const c = loadCreator(req, req.params.handle, { allowLimited: true });
  const cur = cursorSql(parseCursor(req.query.cursor));
  const limit = 36;
  const rows = db
    .prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE p.creator_id = ? AND ${visible(req)} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`)
    .all(c.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, limit) });
});

// Posts of other authors whose caption mentions this creator (Grabbit 3.0.3).
// Same files, same posts: only the post_mentions row ties them here.
creators.get('/creators/:handle/mentioned', (req, res) => {
  const c = loadCreator(req, req.params.handle, { allowLimited: true });
  const cur = cursorSql(parseCursor(req.query.cursor));
  const limit = 36;
  const rows = db
    .prepare(
      `SELECT p.id, p.created_at FROM post_mentions pm ${POST_FROM.replace('FROM posts p', 'JOIN posts p ON p.id = pm.post_id')}
       WHERE pm.creator_id = ? AND (p.creator_id IS NULL OR p.creator_id <> ?) AND ${visible(req)} AND ${cur.sql}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`,
    )
    .all(c.id, c.id, ...cur.args) as any[];
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
    if (b.audience !== undefined) {
      const a = parseClassify(b.audience);
      if (!a || a === 'adult') throw new HttpError(400, 'audience must be general or unknown; use adult for 18+');
      set('audience', a);
    }
  } else if (['ig_handle', 'tiktok_handle', 'ig_autopoll', 'tiktok_autopoll', 'adult', 'audience'].some((k) => b[k] !== undefined)) {
    throw new HttpError(403, 'Changing sync sources, the audience or the 18+ flag needs the profiles permission');
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
  // The edit may have moved the creator out of the caller's scope (e.g. marked
  // 18+): then only acknowledge, like a post edit does, without the profile.
  const scope = scopeOf(req);
  const after = db.prepare(`SELECT * FROM creators c WHERE c.id = ? AND (${scope ? `c.adult = 0 AND ${creatorScopeSql(scope)}` : '1=1'})`).get(c.id);
  if (!after) {
    res.json({ handle: c.handle, out_of_scope: true });
    return;
  }
  res.json(creatorJson(req, after));
});

async function storeImage(req: Request, dir: string, prefix: string): Promise<string> {
  const up = await parseUpload(req);
  try {
    const f = up.files[0];
    if (!f) throw new HttpError(400, 'No file');
    const s = await sniffFile(f.abs);
    if (!s || s.kind !== 'image') throw new HttpError(400, 'Not an image');
    const dest = await placeFile(f.abs, dir, `${prefix}_${Date.now()}`, s.ext);
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
      // A picture a moderator chose counts as a known source for scoped requests;
      // anyone else's upload is of unknown source and shows only unscoped.
      const chosen = req.user!.role === 'admin' || can(req.user!, 'profiles');
      db.prepare(`UPDATE creators SET ${kind}_path = ?, ${kind}_source = ? WHERE id = ?`).run(rel, chosen ? 'chosen' : null, c.id);
      res.json({ ok: true, url: `/m/${kind === 'avatar' ? 'ca' : 'cb'}/${c.id}?v=${Date.now()}` });
    }),
  );
}

creators.delete('/creators/:handle', refuseScoped, requirePerm('profiles'), (req, res) => {
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

creators.post('/creators/:handle/restore', refuseScoped, requirePerm('profiles'), (req, res) => {
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
  // A merge moves every post of the source, including ones a scoped caller
  // cannot see, and its answer counts them; it is a moderation action.
  refuseScoped,
  requirePerm('profiles'),
  ah(async (req, res) => {
    const from = loadCreator(req, str(req.body?.from, 80));
    const into = loadCreator(req, str(req.body?.into, 80));
    if (from.id === into.id) throw new HttpError(400, 'Pick two different profiles');
    let postIds: number[] = [];
    // No post edit moves files while the merge does (withMoveLock).
    await withMoveLock(async () => {
      // Another merge may have finished while this one waited: both profiles must still exist.
      for (const c of [from, into]) {
        const now_ = db.prepare('SELECT handle, deleted FROM creators WHERE id = ?').get(c.id) as { handle: string; deleted: number } | undefined;
        if (!now_ || now_.deleted || now_.handle !== c.handle) throw new HttpError(409, `${c.handle} changed meanwhile; reload and try again`);
      }
      postIds = db.prepare('SELECT id FROM posts WHERE creator_id = ?').pluck().all(from.id) as number[];
      const moved: number[] = [];
      try {
        await moveMediaToAuthor(postIds, { creatorId: into.id }, moved);
        db.transaction(() => {
          // A profile may have been deleted while the files moved (deletes do not
          // take the move lock): then nothing is written.
          for (const c of [from, into]) {
            const now_ = db.prepare('SELECT handle, deleted FROM creators WHERE id = ?').get(c.id) as { handle: string; deleted: number } | undefined;
            if (!now_ || now_.deleted || now_.handle !== c.handle) throw new HttpError(409, `${c.handle} changed meanwhile; reload and try again`);
          }
          // The source is read again here: it may have been classified (18+ or
          // general) while the files were moving, and the merged profile must carry
          // its current classification, not the snapshot taken before the move.
          const cur = db.prepare('SELECT * FROM creators WHERE id = ?').get(from.id) as any;
          if (cur) Object.assign(from, cur);
          db.prepare('UPDATE posts SET creator_id = ? WHERE creator_id = ?').run(into.id, from.id);
          db.prepare('UPDATE creator_aliases SET creator_id = ? WHERE creator_id = ?').run(into.id, from.id);
          db.prepare('INSERT OR IGNORE INTO creator_aliases (alias, creator_id) VALUES (?, ?)').run(from.handle, into.id);
          db.prepare('INSERT OR IGNORE INTO follows (user_id, creator_id, created_at) SELECT user_id, ?, created_at FROM follows WHERE creator_id = ?').run(into.id, from.id);
          db.prepare('DELETE FROM follows WHERE creator_id = ?').run(from.id);
          // Mentions follow the merge; a post of the merged profile no longer mentions its own creator.
          db.prepare('INSERT OR IGNORE INTO post_mentions (post_id, creator_id, name) SELECT post_id, ?, name FROM post_mentions WHERE creator_id = ?').run(into.id, from.id);
          db.prepare('DELETE FROM post_mentions WHERE creator_id = ?').run(from.id);
          db.prepare('DELETE FROM post_mentions WHERE creator_id = ? AND post_id IN (SELECT id FROM posts WHERE creator_id = ?)').run(into.id, into.id);
          db.prepare(
            `UPDATE creators SET
               ig_handle = COALESCE(ig_handle, ?), tiktok_handle = COALESCE(tiktok_handle, ?),
               avatar_source = CASE WHEN avatar_path IS NULL THEN ? ELSE avatar_source END, banner_source = CASE WHEN banner_path IS NULL THEN ? ELSE banner_source END,
               avatar_path = COALESCE(avatar_path, ?), banner_path = COALESCE(banner_path, ?),
               bio = CASE WHEN bio = '' THEN ? ELSE bio END, adult = MAX(adult, ?),
               audience = CASE WHEN audience = 'general' OR ? = 'general' THEN 'general' ELSE audience END
             WHERE id = ?`,
          ).run(from.ig_handle, from.tiktok_handle, from.avatar_source, from.banner_source, from.avatar_path, from.banner_path, from.bio, from.adult, from.audience, into.id);
          // The emptied profile keeps its row (soft-deleted), but its handle is freed to live on as an alias.
          db.prepare("UPDATE creators SET deleted = 1, ig_autopoll = 0, tiktok_autopoll = 0, handle = handle || '~merged' || id WHERE id = ?").run(from.id);
        })();
      } catch (err) {
        // The merge wrote nothing: the files go back to their posts' authors.
        await returnMediaHome(moved);
        throw err;
      }
    });
    reindexCreator(into.id);
    for (const uid of db.prepare('SELECT user_id FROM follows WHERE creator_id = ?').pluck().all(into.id) as number[]) {
      notify({ userId: uid, kind: 'system', creatorId: into.id, text: `${from.handle} was merged into ${into.handle}`, url: `/u/${into.handle}` });
    }
    res.json({ ok: true, moved: postIds.length, into: into.handle });
  }),
);

creators.get('/creators-deleted', refuseScoped, requirePerm('profiles'), (_req, res) => {
  res.json({ items: db.prepare("SELECT id, handle, display_name FROM creators WHERE deleted = 1 AND handle NOT LIKE '%~merged%' ORDER BY handle").all() });
});

