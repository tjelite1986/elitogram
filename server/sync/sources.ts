import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { createPost } from '../library.js';
import { APP_DIRS, mediaAbs } from '../media/files.js';
import { notifyFollowers } from '../notify.js';
import { sleep, type JobContext } from '../jobs/scheduler.js';
import { cookieFor, markCookie } from './cookies.js';
import { runProc } from './runner.js';

const archiveDir = path.join(config.dataDir, 'archives');

interface Creator {
  id: number;
  handle: string;
  ig_handle: string | null;
  tiktok_handle: string | null;
}

export interface SyncOutcome {
  added: number;
  skipped: number;
  message: string;
  blocked?: boolean;
}

async function workDir(source: string, handle: string): Promise<string> {
  const dir = mediaAbs(`${APP_DIRS.tmp}/sync-${source}-${handle}-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function record(creatorId: number, msg: string): void {
  db.prepare('UPDATE creators SET last_sync_at = ?, last_sync_result = ? WHERE id = ?').run(now(), msg.slice(0, 1000), creatorId);
}

const exists = db.prepare('SELECT 1 FROM posts WHERE source_key = ?');

/**
 * Turns downloaded files plus their JSON sidecars into posts filed under the
 * local creator, whatever the remote handle was.
 */
async function ingest(
  creator: Creator,
  dir: string,
  readMeta: (json: any, jsonFile: string) => { key: string; caption: string; createdAt: number | null; url: string | null; num: number } | null,
  ctx: JobContext,
): Promise<{ added: number; skipped: number }> {
  const names = await fsp.readdir(dir);
  const groups = new Map<string, { caption: string; createdAt: number | null; url: string | null; files: { abs: string; name: string; num: number }[] }>();
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    let meta;
    try {
      meta = readMeta(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')), n);
    } catch {
      continue;
    }
    if (!meta) continue;
    const stem = n.replace(/\.json$/, '').replace(/\.info$/, '');
    const media = names.find((x) => x !== n && !x.endsWith('.json') && (x === stem || x.replace(/\.[^.]+$/, '') === stem));
    if (!media) continue;
    const g = groups.get(meta.key) ?? { caption: meta.caption, createdAt: meta.createdAt, url: meta.url, files: [] };
    g.files.push({ abs: path.join(dir, media), name: media, num: meta.num });
    groups.set(meta.key, g);
  }
  let added = 0;
  let skipped = 0;
  // Oldest first, so post ids follow the remote order.
  const ordered = [...groups.entries()].sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0));
  for (const [key, g] of ordered) {
    if (exists.get(key)) {
      skipped++;
      continue;
    }
    g.files.sort((a, b) => a.num - b.num);
    const r = await createPost({
      author: { creatorId: creator.id },
      caption: g.caption,
      createdAt: g.createdAt ?? now(),
      sourceUrl: g.url,
      sourceKey: key,
      files: g.files.map((f) => ({ abs: f.abs, name: f.name })),
    });
    for (const rej of r.rejected) ctx.log(`${creator.handle}: rejected ${rej.name} (${rej.reason})`);
    if (r.postId) {
      added++;
      notifyFollowers(creator.id, r.postId, null);
    }
  }
  return { added, skipped };
}

const BLOCK_RE = /\b429\b|too many requests|login required|redirect(ed)? to login|checkpoint|challenge_required|please wait a few minutes|401 unauthorized|feedback_required/i;

export async function syncInstagram(creator: Creator, ctx: JobContext): Promise<SyncOutcome> {
  const remote = creator.ig_handle;
  if (!remote) return { added: 0, skipped: 0, message: 'no Instagram handle' };
  const c = cookieFor(creator.handle);
  if (!c) return { added: 0, skipped: 0, message: 'no Instagram cookie configured (Settings > Sources)' };
  if ('waiting' in c) return { added: 0, skipped: 0, message: `skipped: ${c.waiting}` };
  fs.mkdirSync(archiveDir, { recursive: true });
  const dir = await workDir('ig', creator.handle);
  try {
    const args = [
      '--cookies', c.path,
      '--write-metadata',
      '--no-mtime',
      '--download-archive', path.join(archiveDir, 'instagram.sqlite3'),
      '--abort', '6',
      '--range', `1-${config.igMaxPostsPerRun * 4}`,
      '--sleep-request', '8-16',
      '--sleep', '2-5',
      '-o', 'extractor.instagram.include=posts',
      '-o', 'extractor.instagram.videos=true',
      '-D', dir,
      '-f', '{post_shortcode}_{num:>02}.{extension}',
      `https://www.instagram.com/${remote}/`,
    ];
    ctx.log(`${creator.handle}: fetching instagram.com/${remote} with cookie "${c.cookie.label}"`);
    const res = await runProc(config.galleryDlBin, args, { timeoutMs: 45 * 60_000 });
    const blocked = BLOCK_RE.test(res.stderr);
    const { added, skipped } = await ingest(
      creator,
      dir,
      (j) => {
        const code = j.post_shortcode ?? j.shortcode;
        if (!code) return null;
        const t = j.post_date ?? j.date;
        return {
          key: `ig:${code}`,
          caption: String(j.description ?? ''),
          createdAt: t ? Date.parse(String(t).replace(' ', 'T') + 'Z') || null : null,
          url: j.post_url ?? `https://www.instagram.com/p/${code}/`,
          num: Number(j.num ?? 0),
        };
      },
      ctx,
    );
    let message = `${added} new posts, ${skipped} already known`;
    if (blocked) {
      markCookie(c.cookie.id, res.stderr.slice(-500), 6);
      message += '; Instagram refused the session, cookie paused for 6 h';
    } else if (res.code !== 0 && added === 0) {
      markCookie(c.cookie.id, res.stderr.slice(-500));
      message += `; gallery-dl exited ${res.code}: ${res.stderr.trim().split('\n').pop() ?? ''}`;
    } else {
      markCookie(c.cookie.id, null);
    }
    record(creator.id, `Instagram: ${message}`);
    return { added, skipped, message, blocked };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

interface TikTokItem {
  id: string;
  photo: boolean;
  createdAt: number | null;
  caption: string;
}

/** Lists a profile's newest posts with gallery-dl; yt-dlp's TikTok user extractor gets an empty item list. */
async function listTikTok(remote: string, limit: number): Promise<{ items: TikTokItem[]; code: number | null; stderr: string }> {
  const res = await runProc(
    config.galleryDlBin,
    ['-N', 'post:{id}\t{post_type}\t{createTime}\t{desc!j}', '--post-range', `1-${limit}`, '--sleep-request', '1.0-3.0', '--retries', '2', `https://www.tiktok.com/@${remote}/posts`],
    { timeoutMs: 20 * 60_000 },
  );
  const items: TikTokItem[] = [];
  for (const line of res.stdout.split('\n')) {
    const [id, type, created, desc] = line.split('\t');
    if (!/^\d{6,25}$/.test(id ?? '')) continue;
    let caption = '';
    try {
      caption = String(JSON.parse(desc ?? '""') ?? '');
    } catch {
      /* keep empty */
    }
    items.push({ id, photo: type !== 'video', createdAt: Number(created) > 0 ? Number(created) * 1000 : null, caption });
  }
  return { items, code: res.code, stderr: res.stderr };
}

export async function syncTikTok(creator: Creator, ctx: JobContext): Promise<SyncOutcome> {
  const remote = creator.tiktok_handle;
  if (!remote) return { added: 0, skipped: 0, message: 'no TikTok handle' };
  const dir = await workDir('tt', creator.handle);
  try {
    ctx.log(`${creator.handle}: listing tiktok.com/@${remote}`);
    const list = await listTikTok(remote, Math.max(30, config.tiktokMaxPostsPerRun * 3));
    const fresh = list.items.filter((it) => !exists.get(`tt:${it.id}`));
    const todo = fresh.slice(0, config.tiktokMaxPostsPerRun);
    const byId = new Map(todo.map((it) => [it.id, it]));
    const failed: string[] = [];
    for (const it of todo) {
      if (ctx.stopped()) break;
      const kind = it.photo ? 'photo' : 'video';
      const url = `https://www.tiktok.com/@${remote}/${kind}/${it.id}`;
      // Photo posts come from gallery-dl (yt-dlp only fetches their music); videos from yt-dlp, because
      // TikTok's HEVC streams are often silent and H.264 plays everywhere.
      const res = it.photo
        ? await runProc(config.galleryDlBin, ['--write-metadata', '--no-mtime', '-o', 'videos=false', '-o', 'audio=false', '-D', dir, '-f', '{id}_{num:>02}.{extension}', url], { timeoutMs: 10 * 60_000 })
        : await runProc(
            config.ytDlpBin,
            ['--no-progress', '--no-warnings', '--write-info-json', '-f', 'bv*[height<=1920]+ba/b[height<=1920]/bv*+ba/b', '-S', 'vcodec:h264', '--merge-output-format', 'mp4', '-o', path.join(dir, '%(id)s.%(ext)s'), url],
            { timeoutMs: 10 * 60_000 },
          );
      if (res.code !== 0) failed.push(`${it.id}: ${res.stderr.trim().split('\n').pop() ?? `exit ${res.code}`}`);
      await sleep(2000 + Math.random() * 4000, ctx);
    }
    const { added, skipped } = await ingest(
      creator,
      dir,
      (j) => {
        const it = byId.get(String(j.id ?? ''));
        if (!it || j._type === 'playlist' || j.type === 'audio' || j.type === 'avatar') return null;
        return {
          key: `tt:${it.id}`,
          caption: it.caption,
          createdAt: it.createdAt,
          url: `https://www.tiktok.com/@${remote}/${it.photo ? 'photo' : 'video'}/${it.id}`,
          num: Number(j.num ?? 0),
        };
      },
      ctx,
    );
    let message = `${added} new posts, ${list.items.length - fresh.length + skipped} already known`;
    if (list.items.length === 0) {
      const err = list.stderr.trim().split('\n').filter((l) => /error|warning/i.test(l)).pop();
      // A throttled TikTok answers with an empty list rather than an error, so say so instead of reporting "0 new".
      message += err ? `; gallery-dl: ${err}` : '; TikTok returned an empty post list (empty or private profile, or throttled)';
    }
    if (failed.length) message += `; ${failed.length} failed (${failed[0]})`;
    for (const f of failed) ctx.log(`${creator.handle}: ${f}`);
    record(creator.id, `TikTok: ${message}`);
    return { added, skipped, message };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export async function runInstagramJob(ctx: JobContext): Promise<string> {
  const list = db
    .prepare("SELECT id, handle, ig_handle, tiktok_handle FROM creators WHERE deleted = 0 AND ig_autopoll = 1 AND ig_handle IS NOT NULL AND ig_handle != '' ORDER BY last_sync_at IS NOT NULL, last_sync_at")
    .all() as Creator[];
  if (list.length === 0) return 'No creators have Instagram auto-poll on';
  let added = 0;
  let done = 0;
  const pausedCookies = new Set<string>();
  for (const [i, c] of list.entries()) {
    if (ctx.stopped()) break;
    const assigned = cookieFor(c.handle);
    if (assigned && 'cookie' in assigned && pausedCookies.has(assigned.path)) continue;
    const r = await syncInstagram(c, ctx);
    ctx.log(`${c.handle}: ${r.message}`);
    added += r.added;
    done++;
    if (r.blocked && assigned && 'cookie' in assigned) pausedCookies.add(assigned.path);
    // Instagram punishes bursts: wait between profiles, randomised.
    if (i < list.length - 1) await sleep(config.igProfileGapSec * 1000 * (1 + Math.random()), ctx);
  }
  return `${done}/${list.length} profiles checked, ${added} new posts${pausedCookies.size ? `, ${pausedCookies.size} cookie(s) paused` : ''}`;
}

export async function runTikTokJob(ctx: JobContext): Promise<string> {
  const list = db
    .prepare("SELECT id, handle, ig_handle, tiktok_handle FROM creators WHERE deleted = 0 AND tiktok_autopoll = 1 AND tiktok_handle IS NOT NULL AND tiktok_handle != '' ORDER BY last_sync_at IS NOT NULL, last_sync_at")
    .all() as Creator[];
  if (list.length === 0) return 'No creators have TikTok auto-poll on';
  let added = 0;
  let done = 0;
  for (const [i, c] of list.entries()) {
    if (ctx.stopped()) break;
    const r = await syncTikTok(c, ctx);
    ctx.log(`${c.handle}: ${r.message}`);
    added += r.added;
    done++;
    if (i < list.length - 1) await sleep(20_000 * (1 + Math.random()), ctx);
  }
  return `${done}/${list.length} profiles checked, ${added} new posts`;
}

export async function downloaderVersions(): Promise<{ ytDlp: string; galleryDl: string }> {
  const [a, b] = await Promise.all([runProc(config.ytDlpBin, ['--version'], { timeoutMs: 20_000 }), runProc(config.galleryDlBin, ['--version'], { timeoutMs: 20_000 })]);
  return { ytDlp: a.code === 0 ? a.stdout.trim() : 'not found', galleryDl: b.code === 0 ? b.stdout.trim() : 'not found' };
}
