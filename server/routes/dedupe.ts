import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from '../db/index.js';
import { effectiveAudience } from '../audience.js';
import { ah } from '../http.js';
import { APP_DIRS, mediaAbs, mediaIdentity } from '../media/files.js';
import { cacheClean, cacheRebuild, cacheStatus } from '../media/cache.js';

/**
 * Grabbit dedupe v1: Elitogram's side of Grabbit's Smart Duplicate Manager.
 *
 * Grabbit reads the media folder (read-only) and never writes to it. It asks
 * here which posts use a file, and asks this app to tidy the thumbnail cache,
 * which only this app may change.
 *
 *   POST /api/dedupe/v1/lookup        { paths: [mediaRel] } -> which posts, creators or stories use each file
 *   GET  /api/dedupe/v1/cache                               -> thumbnail cache counts
 *   POST /api/dedupe/v1/cache/clean   { dryRun }            -> removes unused thumbnails
 *   POST /api/dedupe/v1/cache/rebuild { dryRun }            -> makes missing thumbnails, a batch at a time
 *
 * There is no link/restore/purge here: posts never share a media file in this
 * app, and a duplicate post is removed in Elitogram's own UI.
 *
 * Machine to machine only: X-Grabbit-Dedupe-Token must match the secret in
 * GRABBIT_DEDUPE_TOKEN_FILE (the only source), at least 32 characters.
 * Unset means every route refuses. Mounted before the session and origin
 * checks, so a browser cookie never reaches these routes and never helps.
 */
export const dedupe = Router();

let cached: { at: number; value: string | null } | null = null;
function expectedToken(): string | null {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  // The mounted file is the only source, the same one Grabbit reads; a missing
  // or unreadable file switches the routes off.
  let value: string | null = null;
  const file = process.env.GRABBIT_DEDUPE_TOKEN_FILE;
  if (file) {
    try {
      value = fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      value = null;
    }
  }
  if (value && value.length < 32) value = null;
  cached = { at: Date.now(), value };
  return value;
}

function tokenOk(given: string | undefined): boolean {
  const expected = expectedToken();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

dedupe.use((req: Request, res: Response, next: NextFunction) => {
  if (!tokenOk(req.get('x-grabbit-dedupe-token'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// The body is parsed only after the token matched, and a bad body gets a 4xx
// here (the app's own error handler sits after the session middleware).
dedupe.use(express.json({ limit: '1mb' }));
dedupe.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'Bad request body' });
    return;
  }
  next(err);
});

const dryRunOf = (req: Request) => req.body?.dryRun !== false;

dedupe.get('/cache', ah(async (_req, res) => res.json(await cacheStatus())));
dedupe.post('/cache/clean', ah(async (req, res) => res.json(await cacheClean(dryRunOf(req)))));
dedupe.post('/cache/rebuild', ah(async (req, res) => res.json(await cacheRebuild(dryRunOf(req)))));

interface Ref {
  type: string;
  id: number;
  label: string;
  audience?: string;
  likes?: number;
  comments?: number;
  deleted?: boolean;
}

const postRefs = db.prepare(
  `SELECT p.id, p.caption, p.deleted, p.adult, p.audience, c.adult AS c_adult, c.audience AS c_audience,
          COALESCE(c.handle, u.username) AS who,
          (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
          (SELECT COUNT(*) FROM comments k WHERE k.post_id = p.id) AS comments
     FROM media m JOIN posts p ON p.id = m.post_id LEFT JOIN creators c ON c.id = p.creator_id LEFT JOIN users u ON u.id = p.user_id
    WHERE m.id = ?`,
);

function postRef(mediaId: number, type: string): Ref | null {
  const p = postRefs.get(mediaId) as any;
  if (!p) return null;
  return {
    type,
    id: p.id,
    label: [p.who ? `@${p.who}` : null, p.caption ? String(p.caption).slice(0, 60) : null].filter(Boolean).join(' ') || `#${p.id}`,
    audience: effectiveAudience(p),
    likes: p.likes,
    comments: p.comments,
    deleted: !!p.deleted,
  };
}

const THUMB = /^_thumbs\/[^/]+\/m(\d+)(?:-([0-9a-f]{12}))?_\d+\.webp$/;

function describe(rel: string): { role: string; regenerable: boolean; refs: Ref[] } {
  const thumb = THUMB.exec(rel);
  if (thumb) {
    const row = db.prepare('SELECT id, sha256, path, created_at FROM media WHERE id = ?').get(Number(thumb[1])) as any;
    const current = !!row && !!thumb[2] && mediaIdentity(row) === `${thumb[1]}-${thumb[2]}`;
    const ref = current ? postRef(row.id, 'thumbnail of post') : null;
    return { role: current ? 'thumbnail' : 'unused thumbnail', regenerable: true, refs: ref ? [ref] : [] };
  }
  const top = rel.split('/')[0];
  if (top === APP_DIRS.avatars || top === APP_DIRS.banners) {
    const col = top === APP_DIRS.avatars ? 'avatar_path' : 'banner_path';
    const what = top === APP_DIRS.avatars ? 'picture' : 'banner';
    const refs: Ref[] = (db.prepare(`SELECT id, handle FROM creators WHERE ${col} = ?`).all(rel) as any[]).map((c) => ({ type: `${what} of creator`, id: c.id, label: `@${c.handle}` }));
    if (col === 'avatar_path') {
      for (const u of db.prepare('SELECT id, username FROM users WHERE avatar_path = ?').all(rel) as any[]) refs.push({ type: 'picture of account', id: u.id, label: `@${u.username}` });
    }
    return { role: refs.length ? what : 'none', regenerable: false, refs };
  }
  if (top === APP_DIRS.stories) {
    const refs = (db.prepare('SELECT s.id, u.username FROM stories s JOIN users u ON u.id = s.user_id WHERE s.path = ?').all(rel) as any[]).map((s) => ({ type: 'story', id: s.id, label: `@${s.username}` }));
    return { role: refs.length ? 'story' : 'none', regenerable: false, refs };
  }
  const refs = (db.prepare('SELECT id FROM media WHERE path = ?').all(rel) as any[]).map((m) => postRef(m.id, 'post')).filter((r): r is Ref => !!r);
  return { role: refs.length ? 'media' : 'none', regenerable: false, refs };
}

dedupe.post('/lookup', (req, res) => {
  const paths = req.body?.paths;
  if (!Array.isArray(paths) || paths.length > 500) {
    res.status(400).json({ error: 'paths must be a list of at most 500' });
    return;
  }
  const items = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0') || p.startsWith('/') || p.split('/').includes('..')) {
      res.status(400).json({ error: 'Not a media path' });
      return;
    }
    let abs: string;
    try {
      abs = mediaAbs(p);
    } catch {
      res.status(400).json({ error: 'Not a media path' });
      return;
    }
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    items.push({ path: p, nlink: st ? st.nlink : 0, ino: st ? String(st.ino) : null, ...describe(p) });
  }
  res.json({ items });
});

dedupe.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Unknown failures answer 422, not 5xx: a proxy may replace a 5xx body with its own page.
dedupe.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status;
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  console.error('[dedupe]', err);
  res.status(status === 409 ? 409 : 422).json({ error: (err as Error)?.message || 'Dedupe failed' });
});
