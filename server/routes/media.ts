import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { db } from '../db/index.js';
import { adultUnlocked } from '../auth.js';
import { creatorScopeSql, effectiveAudience, scopeAllows, scopeOf } from '../audience.js';
import { ah, intParam } from '../http.js';
import { mediaAbs } from '../media/files.js';
import { thumbnail } from '../media/probe.js';
import { fallbackAvatar, fallbackBanner, mimeFor, sendFile } from '../media/serve.js';

/** Media URLs: every one requires a session (mounted behind requireUser) and honours the 18+ gate. */
export const media = Router();

function notFound(res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

function loadMedia(req: Request, id: number): any {
  const m = db
    .prepare(
      `SELECT m.id, m.path, m.kind, m.mime, m.missing, p.deleted, p.adult, p.audience, p.uploader_id, p.user_id,
         c.adult AS c_adult, c.audience AS c_audience, c.deleted AS c_deleted, c.handle AS c_handle
       FROM media m JOIN posts p ON p.id = m.post_id LEFT JOIN creators c ON c.id = p.creator_id WHERE m.id = ?`,
    )
    .get(id) as any;
  if (!m || m.missing) return null;
  if ((m.adult || m.c_adult) && !adultUnlocked(req)) return null;
  m.effective = effectiveAudience(m);
  if (!scopeAllows(scopeOf(req), m.effective)) return null;
  // Deleted posts stay viewable only for those who may restore them.
  if ((m.deleted || m.c_deleted) && req.user!.role !== 'admin' && !req.user!.permissions.includes('profiles') && m.uploader_id !== req.user!.id && m.user_id !== req.user!.id) {
    return null;
  }
  return m;
}

/**
 * Tells a proxy (Grabbit's gateway) what it is forwarding, so it can check the
 * audience and author of every file, not only of the JSON that linked to it.
 */
function describe(res: Response, m: any): void {
  res.setHeader('X-Egram-Audience', m.effective);
  if (m.c_handle) res.setHeader('X-Egram-Creator', m.c_handle);
}

/** `?download=1` asks the browser to save the file under its library name. */
function attachment(req: Request, res: Response, rel: string): void {
  if (req.query.download !== '1') return;
  const name = path.basename(rel);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

media.get('/:id(\\d+)', (req, res) => {
  const m = loadMedia(req, intParam(req.params.id));
  if (!m) return notFound(res);
  describe(res, m);
  attachment(req, res, m.path);
  sendFile(req, res, mediaAbs(m.path), m.mime);
});

media.get(
  '/:id(\\d+)/t',
  ah(async (req, res) => {
    const m = loadMedia(req, intParam(req.params.id));
    if (!m) return notFound(res);
    describe(res, m);
    try {
      const w = [320, 480, 1080].includes(Number(req.query.w)) ? Number(req.query.w) : 480;
      const out = await thumbnail(m.path, m.kind, `m${m.id}`, w);
      sendFile(req, res, out, 'image/webp', 'private, max-age=604800');
    } catch {
      // No thumbnail possible: images fall back to the original, videos to a neutral tile.
      if (m.kind === 'image') sendFile(req, res, mediaAbs(m.path), m.mime);
      else fallbackBanner(res);
    }
  }),
);

media.get('/s/:id(\\d+)', (req, res) => {
  const s = db.prepare('SELECT path, mime, adult, audience, expired, expires_at, user_id FROM stories WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!s || (s.adult && !adultUnlocked(req))) return notFound(res);
  const audience = effectiveAudience(s);
  if (!scopeAllows(scopeOf(req), audience)) return notFound(res);
  res.setHeader('X-Egram-Audience', audience);
  if ((s.expired || s.expires_at < Date.now()) && s.user_id !== req.user!.id) return notFound(res);
  sendFile(req, res, mediaAbs(s.path), s.mime);
});

function sendImageOr(req: Request, res: Response, rel: string | null, fallback: () => void): void {
  if (!rel) return fallback();
  let abs: string;
  try {
    abs = mediaAbs(rel);
  } catch {
    return fallback();
  }
  if (!fs.existsSync(abs)) return fallback();
  sendFile(req, res, abs, mimeFor(abs, 'image/jpeg'), 'private, max-age=3600');
}

/** A scoped request gets a creator's own pictures only when the creator is visible in that scope. */
function creatorInScope(req: Request, id: number): boolean {
  const scope = scopeOf(req);
  return !scope || !!db.prepare(`SELECT 1 FROM creators c WHERE c.id = ? AND ${creatorScopeSql(scope)}`).get(id);
}

media.get('/ca/:id(\\d+)', (req, res) => {
  const c = db.prepare('SELECT id, handle, display_name, avatar_path, adult FROM creators WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!c) return fallbackAvatar(res, '?');
  if (c.adult && !adultUnlocked(req)) return fallbackAvatar(res, '18+');
  if (!creatorInScope(req, c.id)) return fallbackAvatar(res, '?');
  sendImageOr(req, res, c.avatar_path, () => fallbackAvatar(res, c.display_name || c.handle));
});

media.get('/cb/:id(\\d+)', (req, res) => {
  const id = intParam(req.params.id);
  const c = db.prepare('SELECT banner_path, adult FROM creators WHERE id = ?').get(id) as any;
  if (!c || (c.adult && !adultUnlocked(req)) || !creatorInScope(req, id)) return fallbackBanner(res);
  sendImageOr(req, res, c.banner_path, () => fallbackBanner(res));
});

media.get('/ua/:id(\\d+)', (req, res) => {
  const u = db.prepare('SELECT username, display_name, avatar_path FROM users WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!u) return fallbackAvatar(res, '?');
  sendImageOr(req, res, u.avatar_path, () => fallbackAvatar(res, u.display_name || u.username));
});
