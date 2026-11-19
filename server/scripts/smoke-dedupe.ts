/**
 * Smoke test for Grabbit dedupe v1 (server/routes/dedupe.ts). Runs on a
 * throwaway DATA_DIR and MEDIA_ROOT, never on a real library:
 *   T=$(mktemp -d) && mkdir -p $T/data $T/media/alice && \
 *   T=$T DATA_DIR=$T/data MEDIA_ROOT=$T/media GRABBIT_DEDUPE_TOKEN=<32+ chars> npx tsx server/scripts/smoke-dedupe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
const T = process.env.T!;
if (!T || path.resolve(process.env.MEDIA_ROOT || '') !== path.join(path.resolve(T), 'media')) throw new Error('Set T and MEDIA_ROOT=$T/media');
const media = path.join(T, 'media');
const { db } = await import('../db/index.js');
const { mediaIdentity } = await import('../media/files.js');
const { dedupe } = await import('../routes/dedupe.js');
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } }).png().toBuffer();
fs.writeFileSync(path.join(media, 'alice/a.png'), png);
fs.writeFileSync(path.join(media, 'alice/b.png'), png);
const now = Date.now();
db.prepare("INSERT INTO creators (id, handle, display_name, created_at) VALUES (1,'alice','Alice',?)").run(now);
db.prepare("INSERT INTO posts (id, creator_id, caption, created_at, imported_at) VALUES (1,1,'first',?,?),(2,1,'second',?,?)").run(now, now, now - 1, now - 1);
const sha = crypto.createHash('sha256').update(png).digest('hex');
db.prepare("INSERT INTO media (id, post_id, kind, mime, path, size, sha256, created_at) VALUES (1,1,'image','image/png','alice/a.png',?,?,?),(2,2,'image','image/png','alice/b.png',?,?,?)").run(png.length, sha, now, png.length, sha + '', now);
const id1 = mediaIdentity({ id: 1, sha256: sha, path: 'alice/a.png', created_at: now });
const put = (rel: string, body = 'x') => { fs.mkdirSync(path.dirname(path.join(media, rel)), { recursive: true }); fs.writeFileSync(path.join(media, rel), body); };
put(`_thumbs/${id1.slice(-2)}/m${id1}_480.webp`, 'current');
put(`_thumbs/01/m1_480.webp`, 'legacy dup');
put(`_thumbs/09/m9_480.webp`, 'legacy no row');
put(`_thumbs/ab/m7-0123456789ab_480.webp`, 'stale');
put(`_thumbs/ab/m7-0123456789ab_480.webp.123.tmp`, 'fresh tmp');
put(`_thumbs/ab/old.webp.55.tmp`, 'old tmp');
fs.utimesSync(path.join(media, '_thumbs/ab/old.webp.55.tmp'), new Date(now - 7200e3), new Date(now - 7200e3));
put(`_thumbs/ab/README`, 'other');
const app = express();
app.use('/api/dedupe/v1', express.json(), dedupe);
const srv = app.listen(0);
const port = (srv.address() as any).port;
const TOK = process.env.GRABBIT_DEDUPE_TOKEN!;
const call = async (method: string, route: string, body?: unknown, tok: string | null = TOK) => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (tok) h['x-grabbit-dedupe-token'] = tok;
  const res = await fetch(`http://127.0.0.1:${port}/api/dedupe/v1/${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json();
  console.log(method, route, res.status, JSON.stringify(j).slice(0, 400));
  return j;
};
await call('GET', 'cache', undefined, null);
await call('GET', 'cache', undefined, 'y'.repeat(40));
await call('GET', 'nope');
await call('GET', 'cache');
await call('POST', 'lookup', { paths: ['alice/a.png', `_thumbs/${id1.slice(-2)}/m${id1}_480.webp`, '_thumbs/01/m1_480.webp', 'alice/none.png'] });
await call('POST', 'lookup', { paths: ['../etc/passwd'] });
await call('POST', 'cache/clean', {});
await call('POST', 'cache/rebuild', {});
await call('POST', 'cache/clean', { dryRun: false });
await call('POST', 'cache/rebuild', { dryRun: false });
await call('GET', 'cache');
console.log(execList());
function execList() { const out: string[] = []; const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(path.join(d, f.name)); else out.push(path.relative(media, path.join(d, f.name))); } }; walk(path.join(media, '_thumbs')); return out.sort().join('\n'); }
srv.close();
