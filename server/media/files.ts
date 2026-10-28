import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

// App-owned folders inside the media root. All start with "_", and creator
// handles may never start with "_" — the reserved list below is a second guard.
export const APP_DIRS = {
  avatars: '_avatars',
  banners: '_banners',
  stories: '_stories',
  thumbs: '_thumbs',
  users: '_users',
  tmp: '_tmp',
} as const;

const RESERVED = new Set([
  'avatars', 'avatar', 'banners', 'banner', 'stories', 'story', 'thumbs', 'thumbnails', 'users', 'user',
  'tmp', 'temp', 'import', 'imports', 'backup', 'backups', 'cookies', 'trash', 'media', 'data', 'api',
  'static', 'assets', 'uploads', 'upload', 'unsorted', 'unmatched', 'lost+found', 'admin', 'settings',
]);

export function isReservedName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n || n.startsWith('_') || n.startsWith('.')) return true;
  if (RESERVED.has(n)) return true;
  return Object.values(APP_DIRS).some((d) => d.toLowerCase() === n);
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

/** Returns an error message, or null when the handle is acceptable. */
export function validateHandle(handle: string): string | null {
  const h = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) return 'Handle must be 1-60 characters: a-z, 0-9, ".", "_" or "-", starting with a letter or digit';
  if (isReservedName(h)) return `"${h}" is a reserved name`;
  if (h.includes('..')) return 'Handle may not contain ".."';
  return null;
}

/** Resolves a path relative to the media root and refuses anything that escapes it. */
export function mediaAbs(rel: string): string {
  const root = config.mediaRoot;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes media root: ${rel}`);
  return abs;
}

export function mediaRel(abs: string): string {
  return path.relative(config.mediaRoot, abs).split(path.sep).join('/');
}

export function ensureMediaDirs(): void {
  fs.mkdirSync(config.mediaRoot, { recursive: true });
  for (const d of Object.values(APP_DIRS)) fs.mkdirSync(path.join(config.mediaRoot, d), { recursive: true });
  fs.mkdirSync(config.importDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
}

export interface Sniffed {
  kind: 'image' | 'video';
  mime: string;
  ext: string;
}

/** Identifies a media file by its leading bytes; the extension is never trusted. */
export function sniffBuffer(b: Buffer): Sniffed | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif', ext: '.avif' };
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return null; // browsers can't show HEIC
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: '.mov' };
    return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', mime: 'video/webm', ext: '.webm' };
  return null;
}

export async function sniffFile(abs: string): Promise<Sniffed | null> {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return sniffBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

function safeBase(name: string): string {
  const base = path.basename(name).replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '');
  return base.slice(0, 80) || 'file';
}

/** Picks a free file name inside a media-root folder. */
export async function uniqueTarget(dirRel: string, nameHint: string, ext: string): Promise<string> {
  const dirAbs = mediaAbs(dirRel);
  await fsp.mkdir(dirAbs, { recursive: true });
  const base = safeBase(nameHint);
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? `${base}${ext}` : `${base}_${i}${ext}`;
    const abs = path.join(dirAbs, name);
    if (!fs.existsSync(abs)) return abs;
  }
  return path.join(dirAbs, `${base}_${crypto.randomBytes(4).toString('hex')}${ext}`);
}

/** Moves a file, falling back to copy + unlink across file systems. */
export async function moveFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest);
  } catch (err: any) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(src);
  }
}

export function creatorDir(handle: string): string {
  const err = validateHandle(handle);
  if (err) throw new Error(err);
  return handle.toLowerCase();
}

export function userDir(userId: number): string {
  return `${APP_DIRS.users}/${userId}`;
}
