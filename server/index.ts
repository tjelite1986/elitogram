import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { db } from './db/index.js';
import { bootstrapAdmin, originCheck, requireUser, sessionMiddleware } from './auth.js';
import { HttpError } from './http.js';
import { ensureMediaDirs } from './media/files.js';
import { initPush } from './notify.js';
import { account } from './routes/account.js';
import { posts } from './routes/posts.js';
import { creators } from './routes/creators.js';
import { stories } from './routes/stories.js';
import { media } from './routes/media.js';
import { admin } from './routes/admin.js';
import { registerJob, startScheduler } from './jobs/scheduler.js';
import { runImport } from './jobs/importer.js';
import { runInstagramJob, runTikTokJob } from './sync/sources.js';
import {
  runAvatarBackfill, runBackup, runDbMaintenance, runDownloaderUpdate, runDuplicateScan, runMissingCheck, runStoryExpiry,
} from './jobs/maintenance.js';

ensureMediaDirs();
bootstrapAdmin();
initPush();

registerJob({ name: 'import', title: 'Import folder', description: 'Sorts files from the drop folder onto creators', defaultInterval: 5, run: runImport });
registerJob({ name: 'instagram_sync', title: 'Instagram sync', description: 'Fetches new posts for creators with Instagram auto-poll on', defaultInterval: 360, run: runInstagramJob });
registerJob({ name: 'tiktok_sync', title: 'TikTok sync', description: 'Fetches new videos for creators with TikTok auto-poll on', defaultInterval: 360, run: runTikTokJob });
registerJob({ name: 'avatar_backfill', title: 'Avatar backfill', description: 'Gives creators without a picture one', defaultInterval: 1440, run: runAvatarBackfill });
registerJob({ name: 'duplicate_scan', title: 'Duplicate scan', description: 'Fingerprints images and reports lookalikes (never deletes)', defaultInterval: 1440, run: runDuplicateScan });
registerJob({ name: 'missing_files', title: 'Missing files check', description: 'Flags rows whose file is gone from disk', defaultInterval: 1440, run: runMissingCheck });
registerJob({ name: 'story_expiry', title: 'Story expiry', description: 'Expires stories after 24 h and removes old story files', defaultInterval: 15, run: runStoryExpiry });
registerJob({ name: 'db_backup', title: 'Database backup', description: `Consistent snapshot, keeps the newest ${config.backupKeep}`, defaultInterval: 1440, run: runBackup });
registerJob({ name: 'db_maintenance', title: 'Database maintenance', description: 'Optimises indexes, prunes sessions, checkpoints the WAL', defaultInterval: 10080, run: runDbMaintenance });
registerJob({ name: 'update_downloaders', title: 'Update downloaders', description: 'Upgrades yt-dlp and gallery-dl', defaultInterval: 1440, run: runDownloaderUpdate });
startScheduler();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(originCheck);
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.use('/api', account);
app.use('/api', requireUser, posts, creators, stories);
app.use('/api/admin', requireUser, admin);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use('/m', requireUser, media);

// --- Single-page app -----------------------------------------------------------

const indexFile = path.join(config.staticDir, 'index.html');
const PUBLIC_FILES = /^\/(assets\/|manifest\.webmanifest$|sw\.js$|icon[\w-]*\.(png|svg)$|favicon\.(ico|svg)$)/;

app.use(
  express.static(config.staticDir, {
    index: false,
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// Signed out, every page redirects to the login screen; only the static shell assets are public.
app.get('*', (req, res) => {
  if (PUBLIC_FILES.test(req.path)) {
    res.status(404).end();
    return;
  }
  if (!req.user && req.path !== '/login') {
    res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (!fs.existsSync(indexFile)) {
    res.status(503).send('Client not built');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexFile);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const server = app.listen(config.port, () => console.log(`Elitogram listening on :${config.port} (${config.appOrigin})`));
server.requestTimeout = 0; // large uploads may take longer than the default five minutes

function shutdown(): void {
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
