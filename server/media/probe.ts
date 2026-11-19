import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from '../config.js';
import { APP_DIRS, mediaAbs } from './files.js';

const run = promisify(execFile);
sharp.cache(false);
sharp.concurrency(2);

export interface Probe {
  width: number | null;
  height: number | null;
  duration: number | null;
}

export async function probeImage(abs: string): Promise<Probe> {
  const m = await sharp(abs).metadata();
  const rotated = (m.orientation ?? 1) >= 5;
  return { width: (rotated ? m.height : m.width) ?? null, height: (rotated ? m.width : m.height) ?? null, duration: null };
}

export async function probeVideo(abs: string): Promise<Probe> {
  const { stdout } = await run(config.ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', abs], { timeout: 60_000 });
  const info = JSON.parse(stdout);
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream');
  let width = v.width ?? null;
  let height = v.height ?? null;
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  const duration = Number(info.format?.duration ?? v.duration) || null;
  return { width, height, duration };
}

export function probe(abs: string, kind: 'image' | 'video'): Promise<Probe> {
  return kind === 'image' ? probeImage(abs) : probeVideo(abs);
}

/** 64-bit difference hash as 16 hex chars. */
export async function dHash(abs: string): Promise<string> {
  const { data } = await sharp(abs, { failOn: 'none' }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let hex = '';
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      byte = (byte << 1) | (data[row * 9 + col] > data[row * 9 + col + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const inflight = new Map<string, Promise<string>>();

/**
 * Returns the absolute path of a cached WebP thumbnail for a media file,
 * creating it on first request. Videos get a frame grabbed by ffmpeg.
 */
export function thumbnail(rel: string, kind: 'image' | 'video', key: string, width = 480): Promise<string> {
  const out = mediaAbs(`${APP_DIRS.thumbs}/${key.slice(-2).padStart(2, '0')}/${key}_${width}.webp`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const pending = inflight.get(out);
  if (pending) return pending;
  const p = (async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const src = mediaAbs(rel);
    let input: Buffer | string = src;
    if (kind === 'video') input = await grabFrame(src);
    const webp = await sharp(input, { failOn: 'none', animated: false }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
    await publishExclusive(out, webp);
    return out;
  })().finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

// O_EXCL with O_CREAT refuses any existing entry, a symlink included, and
// O_NOFOLLOW makes that explicit, so the write lands only in a file this call
// just created. The name is random, so nobody can plant one ahead of it.
const EXCL = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

/** Writes `data` to a fresh temp file next to `out`, then renames it into place. */
async function publishExclusive(out: string, data: Buffer): Promise<void> {
  // The shard must be a real folder: a symlinked one would take the file elsewhere.
  if (!fs.lstatSync(path.dirname(out)).isDirectory()) throw new Error('Thumbnail folder is not a real folder');
  // Matches cache.ts TMP, so an interrupted write is cleaned up later.
  const tmp = `${out}.${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, EXCL, 0o644);
  let done = false;
  try {
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, out);
    done = true;
  } finally {
    if (!done) {
      await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
    }
  }
}

async function grabFrame(src: string): Promise<Buffer> {
  const attempt = async (seek: string) => {
    const { stdout } = await run(config.ffmpegBin, ['-v', 'error', '-ss', seek, '-i', src, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout as unknown as Buffer;
  };
  const buf = await attempt('1');
  return buf.length > 0 ? buf : attempt('0');
}
