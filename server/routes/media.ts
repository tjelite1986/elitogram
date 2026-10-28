import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { db } from '../db/index.js';
import { adultUnlocked } from '../auth.js';
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
      `SELECT m.id, m.path, m.kind, m.mime, m.missing, p.deleted, p.adult, p.uploader_id, p.user_id, c.adult AS c_adult, c.deleted AS c_deleted
       FROM media m JOIN posts p ON p.id = m.post_id LEFT JOIN creators c ON c.id = p.creator_id WHERE m.id = ?`,
    )
    .get(id) as any;
  if (!m || m.missing) return null;
  if ((m.adult || m.c_adult) && !adultUnlocked(req)) return null;
  // Deleted posts stay viewable only for those who may restore them.
  if ((m.deleted || m.c_deleted) && req.user!.role !== 'admin' && !req.user!.permissions.includes('profiles') && m.uploader_id !== req.user!.id && m.user_id !== req.user!.id) {
    return null;
  }
  return m;
}

media.get('/:id(\\d+)', (req, res) => {
  const m = loadMedia(req, intParam(req.params.id));
  if (!m) return notFound(res);
  sendFile(req, res, mediaAbs(m.path), m.mime);
});

media.get(
  '/:id(\\d+)/t',
  ah(async (req, res) => {
    const m = loadMedia(req, intParam(req.params.id));
    if (!m) return notFound(res);
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
  const s = db.prepare('SELECT path, mime, adult, expired, expires_at, user_id FROM stories WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!s || (s.adult && !adultUnlocked(req))) return notFound(res);
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

media.get('/ca/:id(\\d+)', (req, res) => {
  const c = db.prepare('SELECT handle, display_name, avatar_path, adult FROM creators WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!c) return fallbackAvatar(res, '?');
  if (c.adult && !adultUnlocked(req)) return fallbackAvatar(res, '18+');
  sendImageOr(req, res, c.avatar_path, () => fallbackAvatar(res, c.display_name || c.handle));
});

media.get('/cb/:id(\\d+)', (req, res) => {
  const c = db.prepare('SELECT banner_path, adult FROM creators WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!c || (c.adult && !adultUnlocked(req))) return fallbackBanner(res);
  sendImageOr(req, res, c.banner_path, () => fallbackBanner(res));
});

media.get('/ua/:id(\\d+)', (req, res) => {
  const u = db.prepare('SELECT username, display_name, avatar_path FROM users WHERE id = ?').get(intParam(req.params.id)) as any;
  if (!u) return fallbackAvatar(res, '?');
  sendImageOr(req, res, u.avatar_path, () => fallbackAvatar(res, u.display_name || u.username));
});
