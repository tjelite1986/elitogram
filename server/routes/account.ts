import { Router } from 'express';
import { db, now } from '../db/index.js';
import {
  adultUntil, clearAdultUnlock, endSession, hashPassword, PERMISSIONS, requirePerm, requireUser, setAdultUnlock, startSession, verifyPassword,
} from '../auth.js';
import { ah, HttpError, intParam, str } from '../http.js';
import { POST_FROM, visible, parseCursor, cursorSql, nextCursor, gridTiles } from '../views.js';
import { parseUpload } from '../media/upload.js';
import { APP_DIRS, mediaRel, moveFile, sniffFile, uniqueTarget } from '../media/files.js';
import { vapidPublicKey } from '../notify.js';

export const account = Router();

// Simple in-memory throttle for login and PIN attempts.
const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string): void {
  const a = attempts.get(key);
  if (a && a.until > now()) throw new HttpError(429, 'Too many attempts, try again in a minute');
}
function fail(key: string): void {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n++;
  if (a.n >= 5) {
    a.until = now() + 60_000;
    a.n = 0;
  }
  attempts.set(key, a);
}

account.post('/auth/login', (req, res) => {
  const username = str(req.body?.username, 60).trim().toLowerCase();
  const password = str(req.body?.password, 200);
  const key = `login:${req.ip}:${username}`;
  throttle(key);
  const u = db.prepare('SELECT id, password_hash, disabled FROM users WHERE username = ?').get(username) as any;
  if (!u || u.disabled || !verifyPassword(password, u.password_hash)) {
    fail(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  attempts.delete(key);
  startSession(res, u.id);
  res.json({ ok: true });
});

account.post('/auth/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

function badgesOf(userId: number) {
  return db.prepare('SELECT b.id, b.name, b.color FROM badges b JOIN user_badges ub ON ub.badge_id = b.id WHERE ub.user_id = ? ORDER BY b.name').all(userId);
}

account.get('/me', (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  const u = db.prepare('SELECT bio FROM users WHERE id = ?').get(req.user.id) as any;
  res.json({
    user: { ...req.user, bio: u.bio, avatar: `/m/ua/${req.user.id}`, badges: badgesOf(req.user.id) },
    adult_until: adultUntil(req),
    unread: db.prepare('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL').pluck().get(req.user.id),
    vapid_key: vapidPublicKey(),
  });
});

account.use(requireUser);

account.patch('/me', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.display_name === 'string') db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(str(b.display_name, 120), req.user!.id);
  if (typeof b.bio === 'string') db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(str(b.bio, 1000), req.user!.id);
  res.json({ ok: true });
});

account.post('/me/password', (req, res) => {
  const cur = str(req.body?.current, 200);
  const next = str(req.body?.password, 200);
  if (next.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!verifyPassword(cur, u.password_hash)) throw new HttpError(400, 'Current password is wrong');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user!.id);
  res.json({ ok: true });
});

account.post(
  '/me/avatar',
  ah(async (req, res) => {
    const up = await parseUpload(req);
    try {
      const f = up.files[0];
      if (!f) throw new HttpError(400, 'No file');
      const s = await sniffFile(f.abs);
      if (!s || s.kind !== 'image') throw new HttpError(400, 'Not an image');
      const dest = await uniqueTarget(APP_DIRS.avatars, `u${req.user!.id}_${Date.now()}`, s.ext);
      await moveFile(f.abs, dest);
      db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(mediaRel(dest), req.user!.id);
      res.json({ ok: true });
    } finally {
      await up.cleanup();
    }
  }),
);

// --- 18+ PIN ---------------------------------------------------------------

account.post('/me/pin', (req, res) => {
  const pin = str(req.body?.pin, 20);
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4-8 digits');
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!verifyPassword(str(req.body?.password, 200), u.password_hash)) throw new HttpError(400, 'Password is wrong');
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPassword(pin), req.user!.id);
  clearAdultUnlock(res);
  res.json({ ok: true });
});

account.post('/adult/unlock', (req, res) => {
  const key = `pin:${req.user!.id}`;
  throttle(key);
  const u = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!u.pin_hash) throw new HttpError(400, 'Set a PIN in Settings first');
  if (!verifyPassword(str(req.body?.pin, 20), u.pin_hash)) {
    fail(key);
    throw new HttpError(401, 'Wrong PIN');
  }
  attempts.delete(key);
  res.json({ adult_until: setAdultUnlock(res, req.user!.id) });
});

account.post('/adult/lock', (_req, res) => {
  clearAdultUnlock(res);
  res.json({ adult_until: null });
});

// --- Users' own profiles ----------------------------------------------------

account.get('/users/:username', (req, res) => {
  const u = db.prepare('SELECT id, username, display_name, bio, role, created_at FROM users WHERE username = ? AND disabled = 0').get(req.params.username.toLowerCase()) as any;
  if (!u) throw new HttpError(404, 'User not found');
  const posts = db.prepare(`SELECT COUNT(*) FROM posts p LEFT JOIN creators c ON c.id = p.creator_id WHERE (p.user_id = ? OR p.uploader_id = ?) AND ${visible(req)}`).pluck().get(u.id, u.id);
  res.json({ ...u, name: u.display_name || u.username, avatar: `/m/ua/${u.id}`, badges: badgesOf(u.id), post_count: posts, is_me: u.id === req.user!.id });
});

account.get('/users/:username/posts', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username.toLowerCase()) as any;
  if (!u) throw new HttpError(404, 'User not found');
  const cur = cursorSql(parseCursor(req.query.cursor));
  const rows = db
    .prepare(`SELECT p.id, p.created_at ${POST_FROM} WHERE (p.user_id = ? OR p.uploader_id = ?) AND ${visible(req)} AND ${cur.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT 36`)
    .all(u.id, u.id, ...cur.args) as any[];
  res.json({ items: gridTiles(rows), next: nextCursor(rows, 36) });
});

// --- Notifications and push -------------------------------------------------

account.get('/notifications', (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.id, n.kind, n.text, n.post_id, n.creator_id, n.created_at, n.read_at, n.actor_id, c.handle AS creator_handle
       FROM notifications n LEFT JOIN creators c ON c.id = n.creator_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`,
    )
    .all(req.user!.id) as any[];
  res.json({ items: rows.map((r) => ({ ...r, actor_avatar: r.actor_id ? `/m/ua/${r.actor_id}` : r.creator_id ? `/m/ca/${r.creator_id}` : null })) });
});

account.post('/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user!.id);
  res.json({ ok: true });
});

account.post('/push/subscribe', (req, res) => {
  const s = req.body ?? {};
  const endpoint = str(s.endpoint, 1000);
  if (!/^https:\/\//.test(endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError(400, 'Invalid subscription');
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(req.user!.id, endpoint, str(s.keys.p256dh, 200), str(s.keys.auth, 200), now());
  res.json({ ok: true });
});

account.post('/push/unsubscribe', (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(str(req.body?.endpoint, 1000), req.user!.id);
  res.json({ ok: true });
});

// --- User administration ----------------------------------------------------

const admin = Router();
admin.use(requirePerm('users'));

admin.get('/', (_req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, permissions, disabled, created_at, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY username').all() as any[];
  res.json({
    items: users.map((u) => ({ ...u, permissions: JSON.parse(u.permissions), disabled: !!u.disabled, has_pin: !!u.has_pin, badges: badgesOf(u.id) })),
    permissions: PERMISSIONS,
    badges: db.prepare('SELECT id, name, color FROM badges ORDER BY name').all(),
  });
});

admin.post('/', (req, res) => {
  const username = str(req.body?.username, 40).trim().toLowerCase();
  const password = str(req.body?.password, 200);
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) throw new HttpError(400, 'Username: 2-40 characters a-z, 0-9, ".", "_" or "-"');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(400, 'Username is taken');
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  const r = db
    .prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, str(req.body?.display_name, 120) || username, hashPassword(password), role, now());
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

admin.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const b = req.body ?? {};
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as any;
  if (!target) throw new HttpError(404, 'User not found');
  const adminCount = () => db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0").pluck().get() as number;
  db.transaction(() => {
    if (b.role === 'admin' || b.role === 'member') {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'Only an admin can change roles');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
    }
    if (Array.isArray(b.permissions)) {
      const perms = (b.permissions as unknown[]).filter((p): p is string => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p));
      db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), id);
    }
    if (typeof b.disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, id);
      if (b.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (typeof b.password === 'string' && b.password) {
      if (b.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
    }
    if (b.clear_pin === true) db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(id);
    if (Array.isArray(b.badges)) {
      db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) SELECT ?, id FROM badges WHERE id = ?');
      for (const bid of b.badges as unknown[]) ins.run(id, Number(bid));
    }
    if (adminCount() === 0) throw new HttpError(400, 'At least one active admin must remain');
  })();
  res.json({ ok: true });
});

admin.post('/badges', (req, res) => {
  const name = str(req.body?.name, 40).trim();
  const color = /^#[0-9a-f]{6}$/i.test(str(req.body?.color, 7)) ? req.body.color : '#3b82f6';
  if (!name) throw new HttpError(400, 'Badge needs a name');
  const r = db.prepare('INSERT INTO badges (name, color) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color').run(name, color);
  res.json({ id: Number(r.lastInsertRowid) });
});

admin.delete('/badges/:id', (req, res) => {
  db.prepare('DELETE FROM badges WHERE id = ?').run(intParam(req.params.id));
  res.json({ ok: true });
});

account.use('/admin/users', admin);
