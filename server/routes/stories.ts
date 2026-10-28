import { Router } from 'express';
import { db, now } from '../db/index.js';
import { adultUnlocked } from '../auth.js';
import { ah, HttpError, intParam } from '../http.js';
import { parseUpload } from '../media/upload.js';
import { APP_DIRS, mediaRel, moveFile, sniffFile, uniqueTarget } from '../media/files.js';
import { notify } from '../notify.js';

export const stories = Router();

const DAY = 86_400_000;

stories.get('/stories', (req, res) => {
  const adult = adultUnlocked(req) ? '' : 'AND s.adult = 0';
  const rows = db
    .prepare(
      `SELECT s.id, s.user_id, s.kind, s.adult, s.created_at, s.expires_at, u.username, u.display_name,
         EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS seen
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expired = 0 AND s.expires_at > ? ${adult}
       ORDER BY s.created_at`,
    )
    .all(req.user!.id, now()) as any[];
  const groups = new Map<number, any>();
  for (const r of rows) {
    const g = groups.get(r.user_id) ?? { user: { id: r.user_id, username: r.username, name: r.display_name || r.username, avatar: `/m/ua/${r.user_id}` }, items: [] };
    g.items.push({ id: r.id, kind: r.kind, url: `/m/s/${r.id}`, created_at: r.created_at, expires_at: r.expires_at, seen: !!r.seen, adult: !!r.adult });
    groups.set(r.user_id, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, all_seen: g.items.every((i: any) => i.seen), mine: g.user.id === req.user!.id }));
  // Own stories first, then unseen, then most recent.
  list.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.all_seen) - Number(b.all_seen) || b.items.at(-1).created_at - a.items.at(-1).created_at);
  res.json({ items: list });
});

stories.post(
  '/stories',
  ah(async (req, res) => {
    const up = await parseUpload(req);
    try {
      const f = up.files[0];
      if (!f) throw new HttpError(400, 'No file');
      const s = await sniffFile(f.abs);
      if (!s) throw new HttpError(400, 'Not a supported image or video');
      const dest = await uniqueTarget(`${APP_DIRS.stories}/${req.user!.id}`, `story_${Date.now()}`, s.ext);
      await moveFile(f.abs, dest);
      const t = now();
      const r = db
        .prepare('INSERT INTO stories (user_id, kind, mime, path, adult, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user!.id, s.kind, s.mime, mediaRel(dest), up.fields.adult === '1' ? 1 : 0, t, t + DAY);
      const others = db.prepare('SELECT id FROM users WHERE id != ? AND disabled = 0').pluck().all(req.user!.id) as number[];
      for (const uid of others) {
        notify({ userId: uid, kind: 'story', actorId: req.user!.id, text: `${req.user!.display_name || req.user!.username} added a story`, url: '/' });
      }
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } finally {
      await up.cleanup();
    }
  }),
);

stories.post('/stories/:id/view', (req, res) => {
  const id = intParam(req.params.id);
  db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) SELECT id, ?, ? FROM stories WHERE id = ?').run(req.user!.id, now(), id);
  res.json({ ok: true });
});

stories.get('/stories/:id/viewers', (req, res) => {
  const id = intParam(req.params.id);
  const s = db.prepare('SELECT user_id FROM stories WHERE id = ?').get(id) as any;
  if (!s || s.user_id !== req.user!.id) throw new HttpError(404, 'Story not found');
  const rows = db
    .prepare('SELECT u.id, u.username, u.display_name, v.viewed_at FROM story_views v JOIN users u ON u.id = v.user_id WHERE v.story_id = ? AND v.user_id != ? ORDER BY v.viewed_at DESC')
    .all(id, req.user!.id) as any[];
  res.json({ items: rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name || r.username, avatar: `/m/ua/${r.id}`, viewed_at: r.viewed_at })) });
});

stories.delete('/stories/:id', (req, res) => {
  const id = intParam(req.params.id);
  const s = db.prepare('SELECT user_id FROM stories WHERE id = ?').get(id) as any;
  if (!s || (s.user_id !== req.user!.id && req.user!.role !== 'admin')) throw new HttpError(404, 'Story not found');
  // Expire rather than delete; the expiry job removes the file later.
  db.prepare('UPDATE stories SET expired = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});
