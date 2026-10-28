import fs from 'node:fs';
import { pipeline } from 'node:stream';
import type { Request, Response } from 'express';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

export function mimeFor(file: string, fallback = 'application/octet-stream'): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

/**
 * Streams a file with HTTP range support. A client that disconnects mid-stream
 * only ends that stream; errors are swallowed instead of reaching the process.
 */
export function sendFile(req: Request, res: Response, abs: string, mime: string, cache = 'private, max-age=86400'): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', etag);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const range = req.headers.range;
  if (!range && req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  let start = 0;
  let end = st.size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
      return;
    }
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    }
    if (start > end || start >= st.size) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs, { start, end });
  pipeline(stream, res, (err) => {
    if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error(`Stream error for ${abs}: ${err.message}`);
    }
  });
}

const PALETTE = ['#f97316', '#ec4899', '#8b5cf6', '#3b82f6', '#14b8a6', '#22c55e', '#eab308', '#ef4444'];

/** A generated avatar, served with 200 so a missing picture never becomes a 404. */
export function fallbackAvatar(res: Response, name: string): void {
  const initials = (name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[h % PALETTE.length];
  const esc = initials.replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${color}"/><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="40" font-weight="600" fill="#fff">${esc}</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.send(svg);
}

export function fallbackBanner(res: Response): void {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 1" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="3" height="1" fill="url(#g)"/></svg>');
}
