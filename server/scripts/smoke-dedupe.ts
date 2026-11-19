/**
 * Smoke test for Grabbit dedupe v1 (server/routes/dedupe.ts). Runs on a
 * throwaway DATA_DIR and MEDIA_ROOT, never on a real library:
 *   T=$(mktemp -d) && mkdir -p $T/data $T/media && \
 *   head -c 48 /dev/urandom | base64 > $T/token && \
 *   T=$T DATA_DIR=$T/data MEDIA_ROOT=$T/media GRABBIT_DEDUPE_TOKEN_FILE=$T/token npx tsx server/scripts/smoke-dedupe.ts
 * Exits non-zero when a check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
const T = process.env.T!;
if (!T || path.resolve(process.env.MEDIA_ROOT || '') !== path.join(path.resolve(T), 'media')) throw new Error('Set T and MEDIA_ROOT=$T/media');
if (path.resolve(process.env.DATA_DIR || '') !== path.join(path.resolve(T), 'data')) throw new Error('Set DATA_DIR=$T/data');
// A fresh throwaway folder only: never a library that already has files.
if (fs.existsSync(path.join(T, 'data')) && fs.readdirSync(path.join(T, 'data')).length) throw new Error('$T/data must be empty');
if (fs.existsSync(path.join(T, 'media', '_thumbs'))) throw new Error('$T/media must be fresh');
const media = path.join(T, 'media');
// The test writes alice/ itself; one that is already there (or a symlink to
// a real library) is refused before anything is written.
try {
  fs.lstatSync(path.join(media, 'alice'));
  throw new Error('$T/media/alice must not exist before the test');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
fs.mkdirSync(media, { recursive: true });
fs.mkdirSync(path.join(media, 'alice'));
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
app.use('/api/dedupe/v1', dedupe);
const srv = app.listen(0);
const port = (srv.address() as any).port;
const TOK = fs.readFileSync(process.env.GRABBIT_DEDUPE_TOKEN_FILE!, 'utf8').trim();
const call = async (method: string, route: string, body?: unknown, tok: string | null = TOK) => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (tok) h['x-grabbit-dedupe-token'] = tok;
  const res = await fetch(`http://127.0.0.1:${port}/api/dedupe/v1/${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await res.json();
  console.log(method, route, res.status, JSON.stringify(j).slice(0, 400));
  return Object.assign(j, { status: res.status });
};
let failed = 0;
const expect = (name: string, ok: boolean) => { console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) failed++; };
const exists = (rel: string) => fs.existsSync(path.join(media, rel));
const currentThumb = `_thumbs/${id1.slice(-2)}/m${id1}_480.webp`;
// Extra stale thumbnails, so one clean cannot take them all.
for (let i = 0; i < 120; i++) put(`_thumbs/cd/m${5000 + i}-0123456789ab_480.webp`, 'stale bulk');
expect('no token: 401', (await call('GET', 'cache', undefined, null)).status === 401);
expect('wrong token: 401', (await call('GET', 'cache', undefined, 'y'.repeat(40))).status === 401);
expect('unknown route: 404', (await call('GET', 'nope')).status === 404);
const bad = await fetch(`http://127.0.0.1:${port}/api/dedupe/v1/lookup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-grabbit-dedupe-token': TOK }, body: '{not json' });
expect('bad JSON: 400', bad.status === 400);
const unauthBig = await fetch(`http://127.0.0.1:${port}/api/dedupe/v1/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_000) });
expect('unauthenticated body is never parsed: 401, not 413', unauthBig.status === 401);
await call('GET', 'cache');
const lk = await call('POST', 'lookup', { paths: ['alice/a.png', currentThumb, '_thumbs/01/m1_480.webp', 'alice/none.png'] });
expect('lookup: post and current thumbnail found', lk.items?.[0]?.refs?.length === 1 && lk.items?.[1]?.role === 'thumbnail');
expect('lookup refuses ..', (await call('POST', 'lookup', { paths: ['../etc/passwd'] })).status === 400);
expect('a GRABBIT_DEDUPE_TOKEN env value is not a key', (await call('GET', 'cache', undefined, 'e'.repeat(40))).status === 401);
const dry = await call('POST', 'cache/clean', {});
expect('clean is a dry run by default', dry.dryRun === true && exists('_thumbs/01/m1_480.webp'));
expect('dry run names the 100-file batch', dry.nextBatch?.files === 100 && dry.files > 100);
await call('POST', 'cache/rebuild', {});
const c1 = await call('POST', 'cache/clean', { dryRun: false });
expect('one clean removes at most 100', c1.files === 100 && c1.remaining > 0);
expect('current thumbnail survives', exists(currentThumb));
let rounds = 0;
while (rounds++ < 5 && (await call('POST', 'cache/clean', { dryRun: false })).remaining > 0);
expect('repeated cleans finish', !exists('_thumbs/01/m1_480.webp') && !exists('_thumbs/ab/m7-0123456789ab_480.webp'));
expect('fresh tmp and foreign files stay', exists('_thumbs/ab/m7-0123456789ab_480.webp.123.tmp') && exists('_thumbs/ab/README'));
expect('current thumbnail still there', exists(currentThumb));
await call('POST', 'cache/rebuild', { dryRun: false });
await call('GET', 'cache');
console.log(execList());
// A _thumbs that is a symlink: the rebuild refuses and writes nothing there.
const elsewhere = path.join(T, 'elsewhere');
fs.mkdirSync(elsewhere);
fs.renameSync(path.join(media, '_thumbs'), path.join(media, '_thumbs.real'));
fs.symlinkSync(elsewhere, path.join(media, '_thumbs'));
const rb = await call('POST', 'cache/rebuild', { dryRun: false });
expect('rebuild refuses a symlinked _thumbs', rb.status === 409 && fs.readdirSync(elsewhere).length === 0);
const cl = await call('POST', 'cache/clean', { dryRun: false });
expect('clean finds nothing through a symlinked _thumbs', cl.files === 0 && fs.readdirSync(elsewhere).length === 0);
fs.unlinkSync(path.join(media, '_thumbs'));
fs.renameSync(path.join(media, '_thumbs.real'), path.join(media, '_thumbs'));
// The token file is read on every request: a rotated token works at once,
// the old one stops, and a removed file closes the routes.
const NEW = 'n'.repeat(40);
fs.writeFileSync(process.env.GRABBIT_DEDUPE_TOKEN_FILE!, NEW);
expect('rotated token works at once', (await call('GET', 'cache', undefined, NEW)).status !== 401);
expect('old token refused at once', (await call('GET', 'cache', undefined, TOK)).status === 401);
fs.unlinkSync(process.env.GRABBIT_DEDUPE_TOKEN_FILE!);
expect('missing token file fails closed', (await call('GET', 'cache', undefined, NEW)).status === 401);
function execList() { const out: string[] = []; const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(path.join(d, f.name)); else out.push(path.relative(media, path.join(d, f.name))); } }; walk(path.join(media, '_thumbs')); return out.sort().join('\n'); }
srv.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
