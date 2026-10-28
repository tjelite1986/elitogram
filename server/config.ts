import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const isProd = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(env('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });

// The 18+ cookie key belongs to this app alone. In production it must come from
// the environment; in development a random key is generated and kept on disk.
function adultSecret(): string {
  const fromEnv = process.env.ADULT_COOKIE_SECRET;
  if (fromEnv) return fromEnv;
  if (isProd) throw new Error('ADULT_COOKIE_SECRET must be set in production');
  const file = path.join(dataDir, '.adult-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const appOrigin = env('APP_ORIGIN', 'http://localhost:3000').replace(/\/$/, '');

export const config = {
  isProd,
  port: Number(env('PORT', '3000')),
  appOrigin,
  // Extra origins allowed to send writes (e.g. the Vite dev server).
  extraOrigins: env('EXTRA_ORIGINS', isProd ? '' : 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: env('COOKIE_SECURE', appOrigin.startsWith('https:') ? 'true' : 'false') === 'true',
  dataDir,
  dbFile: path.join(dataDir, 'elitogram.db'),
  mediaRoot: path.resolve(env('MEDIA_ROOT', './data/media')),
  importDir: path.resolve(env('IMPORT_DIR', './data/import')),
  backupDir: path.resolve(env('BACKUP_DIR', './data/backups')),
  backupKeep: Number(env('BACKUP_KEEP', '7')),
  adultSecret: adultSecret(),
  adultUnlockMinutes: Number(env('ADULT_UNLOCK_MINUTES', '60')),
  sessionDays: Number(env('SESSION_DAYS', '60')),
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  ytDlpBin: env('YTDLP_BIN', 'yt-dlp'),
  galleryDlBin: env('GALLERYDL_BIN', 'gallery-dl'),
  // pip of the virtualenv that holds yt-dlp and gallery-dl; used by the update job.
  downloaderPip: process.env.DOWNLOADER_PIP || '',
  ffprobeBin: env('FFPROBE_BIN', 'ffprobe'),
  ffmpegBin: env('FFMPEG_BIN', 'ffmpeg'),
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: env('VAPID_SUBJECT', 'mailto:admin@localhost'),
  // Seconds between two Instagram profiles in one sync run (randomised up to 2x).
  igProfileGapSec: Number(env('IG_PROFILE_GAP_SEC', '90')),
  igMaxPostsPerRun: Number(env('IG_MAX_POSTS_PER_RUN', '24')),
  tiktokMaxPostsPerRun: Number(env('TIKTOK_MAX_POSTS_PER_RUN', '20')),
  // Files in the import folder younger than this are still being uploaded.
  importMinAgeSec: Number(env('IMPORT_MIN_AGE_SEC', '120')),
  staticDir: path.resolve(env('STATIC_DIR', './dist/client')),
};
