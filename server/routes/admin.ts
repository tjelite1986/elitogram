import { Router } from 'express';
import { db, now } from '../db/index.js';
import { requirePerm } from '../auth.js';
import { ah, HttpError, intParam, str } from '../http.js';
import { listJobs, runJob, stopJob, updateJob, isRunning } from '../jobs/scheduler.js';
import { importStatus } from '../jobs/importer.js';
import { purgePosts } from '../jobs/maintenance.js';
import { deleteCookie, listCookies, saveCookieFile } from '../sync/cookies.js';
import { downloaderVersions, syncInstagram, syncTikTok } from '../sync/sources.js';
import { indexPost } from '../library.js';
import { config } from '../config.js';

export const admin = Router();

// --- Jobs ---------------------------------------------------------------------

admin.get('/jobs', requirePerm('jobs'), (_req, res) => {
  res.json({ items: listJobs() });
});

admin.patch('/jobs/:name', requirePerm('jobs'), (req, res) => {
  try {
    updateJob(req.params.name, {
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      interval_minutes: req.body?.interval_minutes !== undefined ? Number(req.body.interval_minutes) : undefined,
    });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  res.json({ items: listJobs() });
});

admin.post('/jobs/:name/run', requirePerm('jobs'), (req, res) => {
  if (isRunning(req.params.name)) throw new HttpError(409, 'Job is already running');
  try {
    void runJob(req.params.name, 'manual');
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  res.status(202).json({ items: listJobs() });
});

admin.post('/jobs/:name/stop', requirePerm('jobs'), (req, res) => {
  res.json({ stopping: stopJob(req.params.name) });
});

// --- Import -------------------------------------------------------------------

admin.get(
  '/import',
  requirePerm('import'),
  ah(async (_req, res) => {
    res.json({ ...(await importStatus()), min_age_sec: config.importMinAgeSec, job: listJobs().find((j) => j.name === 'import') });
  }),
);

admin.post('/import/run', requirePerm('import'), (_req, res) => {
  if (isRunning('import')) throw new HttpError(409, 'Import is already running');
  void runJob('import', 'manual');
  res.status(202).json({ ok: true });
});

// --- Duplicates ---------------------------------------------------------------

admin.get('/duplicates', requirePerm('duplicates'), (req, res) => {
  const status = ['open', 'ignored', 'resolved'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
  const groups = db.prepare('SELECT id, status, created_at FROM dup_groups WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status) as any[];
  const members = db.prepare(
    `SELECT dm.media_id, dm.distance, m.post_id, m.width, m.height, m.size, p.deleted, p.caption, p.created_at, c.handle
     FROM dup_members dm JOIN media m ON m.id = dm.media_id JOIN posts p ON p.id = m.post_id LEFT JOIN creators c ON c.id = p.creator_id
     WHERE dm.group_id = ? ORDER BY m.width * m.height DESC`,
  );
  res.json({
    counts: Object.fromEntries((db.prepare('SELECT status, COUNT(*) n FROM dup_groups GROUP BY status').all() as any[]).map((r) => [r.status, r.n])),
    items: groups.map((g) => ({ ...g, members: (members.all(g.id) as any[]).map((m) => ({ ...m, deleted: !!m.deleted, thumb: `/m/${m.media_id}/t` })) })),
  });
});

admin.post('/duplicates/:id', requirePerm('duplicates'), (req, res) => {
  const id = intParam(req.params.id);
  const status = str(req.body?.status, 10);
  if (!['open', 'ignored', 'resolved'].includes(status)) throw new HttpError(400, 'Invalid status');
  db.prepare('UPDATE dup_groups SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(status, now(), req.user!.id, id);
  res.json({ ok: true });
});

// --- Cleaning -----------------------------------------------------------------

admin.get('/cleaning', requirePerm('cleaning'), (_req, res) => {
  const deleted = db
    .prepare(
      `SELECT p.id, p.caption, p.deleted_at, p.created_at, COALESCE(c.handle, u.username) AS author,
         (SELECT id FROM media WHERE post_id = p.id ORDER BY position LIMIT 1) AS media_id,
         (SELECT COUNT(*) FROM media WHERE post_id = p.id) AS media_count
       FROM posts p LEFT JOIN creators c ON c.id = p.creator_id LEFT JOIN users u ON u.id = p.user_id
       WHERE p.deleted = 1 ORDER BY p.deleted_at DESC LIMIT 200`,
    )
    .all() as any[];
  const missing = db
    .prepare(
      `SELECT m.id, m.path, m.post_id, COALESCE(c.handle, '') AS handle FROM media m JOIN posts p ON p.id = m.post_id LEFT JOIN creators c ON c.id = p.creator_id
       WHERE m.missing = 1 LIMIT 200`,
    )
    .all();
  const empty = db
    .prepare('SELECT c.id, c.handle FROM creators c WHERE c.deleted = 0 AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.creator_id = c.id AND p.deleted = 0) ORDER BY c.handle LIMIT 200')
    .all();
  res.json({
    deleted: deleted.map((d) => ({ ...d, thumb: d.media_id ? `/m/${d.media_id}/t` : null })),
    deleted_total: db.prepare('SELECT COUNT(*) FROM posts WHERE deleted = 1').pluck().get(),
    missing,
    missing_total: db.prepare('SELECT COUNT(*) FROM media WHERE missing = 1').pluck().get(),
    empty_creators: empty,
  });
});

admin.post('/cleaning/restore', requirePerm('cleaning'), (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger) as number[];
  const upd = db.prepare('UPDATE posts SET deleted = 0, deleted_at = NULL WHERE id = ?');
  db.transaction(() => ids.forEach((id) => upd.run(id)))();
  ids.forEach(indexPost);
  res.json({ restored: ids.length });
});

admin.post(
  '/cleaning/purge',
  requirePerm('cleaning'),
  ah(async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger) as number[];
    if (req.body?.confirm !== 'PURGE') throw new HttpError(400, 'Purging needs confirm = "PURGE"');
    res.json(await purgePosts(ids));
  }),
);

// --- Sources ------------------------------------------------------------------

admin.get(
  '/sources',
  requirePerm('sources'),
  ah(async (_req, res) => {
    const cookies = listCookies().map((c) => ({ ...c, file: undefined, disabled: !!c.disabled, cooling: !!c.cooldown_until && c.cooldown_until > now() }));
    const creators = db
      .prepare(
        `SELECT id, handle, ig_handle, tiktok_handle, ig_autopoll, tiktok_autopoll, last_sync_at, last_sync_result FROM creators
         WHERE deleted = 0 AND (ig_handle IS NOT NULL OR tiktok_handle IS NOT NULL) ORDER BY handle`,
      )
      .all();
    res.json({ cookies, creators, versions: await downloaderVersions(), can_update: !!config.downloaderPip });
  }),
);

admin.post('/sources/cookies', requirePerm('sources'), (req, res) => {
  try {
    const id = saveCookieFile(str(req.body?.label, 60), str(req.body?.content, 200_000));
    res.status(201).json({ id });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

admin.patch('/sources/cookies/:id', requirePerm('sources'), (req, res) => {
  const id = intParam(req.params.id);
  if (typeof req.body?.disabled === 'boolean') db.prepare('UPDATE cookies SET disabled = ? WHERE id = ?').run(req.body.disabled ? 1 : 0, id);
  if (req.body?.clear_cooldown) db.prepare('UPDATE cookies SET cooldown_until = NULL WHERE id = ?').run(id);
  if (typeof req.body?.label === 'string') db.prepare('UPDATE cookies SET label = ? WHERE id = ?').run(str(req.body.label, 60), id);
  res.json({ ok: true });
});

admin.delete('/sources/cookies/:id', requirePerm('sources'), (req, res) => {
  deleteCookie(intParam(req.params.id));
  res.json({ ok: true });
});

const manualSyncs = new Set<number>();

/** Syncs one creator now; responds when done (a single profile is quick). */
admin.post(
  '/sources/sync/:creatorId',
  requirePerm('sources'),
  ah(async (req, res) => {
    const id = intParam(req.params.creatorId);
    const source = str(req.body?.source, 10);
    const c = db.prepare('SELECT id, handle, ig_handle, tiktok_handle FROM creators WHERE id = ? AND deleted = 0').get(id) as any;
    if (!c) throw new HttpError(404, 'Creator not found');
    if (manualSyncs.has(id) || isRunning(source === 'instagram' ? 'instagram_sync' : 'tiktok_sync')) throw new HttpError(409, 'A sync is already running');
    if (source !== 'instagram' && source !== 'tiktok') throw new HttpError(400, 'source must be instagram or tiktok');
    // A sync can take many minutes, longer than the proxy keeps a request open; the outcome lands in last_sync_result.
    manualSyncs.add(id);
    const ctx = { log: (m: string) => console.log(`[sync] ${m}`), stopped: () => false };
    (source === 'instagram' ? syncInstagram(c, ctx) : syncTikTok(c, ctx))
      .catch((err: Error) => console.error(`[sync] ${c.handle}: ${err.message}`))
      .finally(() => manualSyncs.delete(id));
    res.status(202).json({ started: true });
  }),
);
