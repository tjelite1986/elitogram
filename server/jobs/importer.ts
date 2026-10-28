import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { createCreator, createPost, findCreatorByName, type IncomingFile } from '../library.js';
import { APP_DIRS, mediaAbs, validateHandle, moveFile } from '../media/files.js';
import { notifyFollowers } from '../notify.js';
import { squareAvatar } from './maintenance.js';
import type { JobContext } from './scheduler.js';

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|m4v|mov|webm)$/i;
const SIDECAR_EXT = /\.(txt|json)$/i;
const PARTIAL = /\.(part|tmp|crdownload|filepart|partial|download)$|^\./i;
const DONE_DIR = '.processed';
const REJECTED_DIR = '.rejected';

export interface PendingFile {
  rel: string;
  abs: string;
  size: number;
  mtime: number;
  young: boolean;
}

async function walk(dir: string, base: string, depth: number, out: PendingFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 2) await walk(abs, base, depth + 1, out);
      continue;
    }
    if (!e.isFile() || PARTIAL.test(e.name)) continue;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    out.push({ rel: path.relative(base, abs), abs, size: st.size, mtime: st.mtimeMs, young: Date.now() - st.mtimeMs < config.importMinAgeSec * 1000 });
  }
}

export async function scanImportDir(): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  await walk(config.importDir, config.importDir, 0, out);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const DATE_TOKEN = /(?:^|[_ .-])((?:19|20)\d{2}-?\d{2}-?\d{2}(?:[_ T-]?\d{2}[-.:]?\d{2}[-.:]?\d{2})?|\d{10,13})(?=$|[_ .-])/;

/** Guesses a handle from a file name like "some.handle_2024-05-01_12-00-00_1.jpg". */
export function handleFromFileName(stem: string): string | null {
  const m = DATE_TOKEN.exec(stem);
  if (!m || m.index === 0) return null;
  const candidate = stem.slice(0, m.index).replace(/[_ .-]+$/, '').toLowerCase();
  return validateHandle(candidate) ? null : candidate;
}

function dateFromName(stem: string): number | null {
  const m = DATE_TOKEN.exec(stem);
  if (!m) return null;
  const raw = m[1];
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length === 13 ? n : n * 1000;
    return ms > Date.UTC(2005, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null;
  }
  const d = raw.replace(/[^\d]/g, '');
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10) || '12'}:${d.slice(10, 12) || '00'}:${d.slice(12, 14) || '00'}`;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Files that only differ by a trailing index ("_1", " (2)", "-3") belong to one post. */
export function groupKey(stem: string): string {
  return stem.replace(/(?:[_ -]\(?\d{1,2}\)?|\s\(\d+\))$/, '');
}

/** Finds the creator a file belongs to: its subfolder, then the longest known handle or alias it starts with, then a parsed handle. */
function resolveCreator(f: PendingFile): { id: number; created: boolean } | { unmatched: string } {
  const parts = f.rel.split(path.sep);
  if (parts.length > 1) {
    const folder = parts[0].toLowerCase();
    const found = findCreatorByName(folder);
    if (found) return { id: found.id, created: false };
    if (validateHandle(folder)) return { unmatched: `folder "${parts[0]}" is not a valid creator handle` };
    return { id: createCreator(folder), created: true };
  }
  const stem = path.basename(f.rel).replace(/\.[^.]+$/, '').toLowerCase();
  const names = db
    .prepare(
      `SELECT handle AS name, id FROM creators WHERE deleted = 0
       UNION ALL SELECT a.alias, a.creator_id FROM creator_aliases a JOIN creators c ON c.id = a.creator_id WHERE c.deleted = 0`,
    )
    .all() as { name: string; id: number }[];
  let best: { name: string; id: number } | null = null;
  for (const n of names) {
    if (stem === n.name || (stem.startsWith(n.name) && /[_ .-]/.test(stem[n.name.length] ?? ''))) {
      if (!best || n.name.length > best.name.length) best = n;
    }
  }
  if (best) return { id: best.id, created: false };
  const parsed = handleFromFileName(stem);
  if (parsed) return { id: createCreator(parsed), created: true };
  return { unmatched: 'no creator matches the file name' };
}

interface FileMeta {
  sidecar: string | null;
  caption: string;
  shortcode: string | null;
  postUrl: string | null;
  index: number | null;
}

async function readJson(abs: string): Promise<any> {
  try {
    return JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch {
    return null;
  }
}

/** Reads the per-file JSON sidecar ("<file stem>.json") that phone downloaders write next to each media file. */
async function fileMeta(f: PendingFile): Promise<FileMeta> {
  const abs = f.abs.replace(/\.[^.]+$/, '.json');
  const j = fs.existsSync(abs) ? await readJson(abs) : null;
  if (!j || typeof j !== 'object') return { sidecar: null, caption: '', shortcode: null, postUrl: null, index: null };
  const shortcode = j.source === 'instagram' && typeof j.shortcode === 'string' && /^[\w-]{5,40}$/.test(j.shortcode) ? j.shortcode : null;
  return {
    sidecar: abs,
    caption: String(j.caption ?? j.description ?? j.title ?? ''),
    shortcode,
    postUrl: typeof j.post_url === 'string' && /^https:\/\//.test(j.post_url) ? j.post_url : null,
    index: Number.isInteger(j.media_index) ? j.media_index : null,
  };
}

/** Applies a "kind: profile" sidecar to its creator: fills empty fields and a missing avatar, never overwrites. */
async function applyProfile(f: PendingFile, j: any, ctx: JobContext): Promise<boolean> {
  const parts = f.rel.split(path.sep);
  const name = String(parts.length > 1 ? parts[0] : (j.username ?? '')).toLowerCase();
  const c = name ? (findCreatorByName(name) as { id: number } | undefined) : undefined;
  if (!c) return false;
  const row = db.prepare('SELECT handle, display_name, bio, ig_handle, avatar_path FROM creators WHERE id = ?').get(c.id) as any;
  const fullName = typeof j.full_name === 'string' ? j.full_name.slice(0, 120) : '';
  if (fullName && (!row.display_name || row.display_name === row.handle)) db.prepare('UPDATE creators SET display_name = ? WHERE id = ?').run(fullName, c.id);
  if (typeof j.bio === 'string' && j.bio && !row.bio) db.prepare('UPDATE creators SET bio = ? WHERE id = ?').run(j.bio.slice(0, 2000), c.id);
  const remote = String(j.username ?? '').toLowerCase();
  if (j.source === 'instagram' && !row.ig_handle && /^[a-z0-9._]{1,30}$/.test(remote)) db.prepare('UPDATE creators SET ig_handle = ? WHERE id = ?').run(remote, c.id);
  if (!row.avatar_path && typeof j.profile_pic_url === 'string' && /^https:\/\/[^/]+\.(cdninstagram\.com|fbcdn\.net|tiktokcdn[\w-]*\.com)\//.test(j.profile_pic_url)) {
    const tmp = mediaAbs(`${APP_DIRS.tmp}/profile-${c.id}-${Date.now()}`);
    try {
      const r = await fetch(j.profile_pic_url, { signal: AbortSignal.timeout(30_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !/^image\//.test(r.headers.get('content-type') ?? '') || buf.length > 10 * 1024 * 1024) throw new Error(`profile picture: HTTP ${r.status}`);
      await fsp.writeFile(tmp, buf);
      db.prepare('UPDATE creators SET avatar_path = ? WHERE id = ?').run(await squareAvatar(tmp, `c${c.id}`), c.id);
    } catch (err) {
      ctx.log(`${row.handle}: ${(err as Error).message}`);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  return true;
}

async function readSidecar(dir: string, key: string, used: Set<string>): Promise<string> {
  for (const ext of ['.txt', '.json']) {
    const abs = path.join(dir, key + ext);
    if (!fs.existsSync(abs)) continue;
    used.add(abs);
    const text = await fsp.readFile(abs, 'utf8').catch(() => '');
    if (ext === '.json') {
      try {
        const j = JSON.parse(text);
        return String(j.caption ?? j.description ?? j.title ?? '');
      } catch {
        return '';
      }
    }
    return text.trim();
  }
  return '';
}

async function setAside(abs: string, sub: string): Promise<void> {
  const rel = path.relative(config.importDir, abs);
  const dest = path.join(config.importDir, sub, rel);
  let target = dest;
  for (let i = 1; fs.existsSync(target); i++) target = dest.replace(/(\.[^.]+)?$/, `_${i}$1`);
  await moveFile(abs, target).catch(() => undefined);
}

export async function runImport(ctx: JobContext): Promise<string> {
  const files = await scanImportDir();
  const ready = files.filter((f) => !f.young && MEDIA_EXT.test(f.rel));
  const young = files.filter((f) => f.young).length;
  const groups = new Map<string, { creatorId: number; files: { f: PendingFile; meta: FileMeta }[]; dir: string; key: string; shortcode: string | null }>();
  const unmatched: string[] = [];
  let newCreators = 0;
  for (const f of ready) {
    const r = resolveCreator(f);
    if ('unmatched' in r) {
      unmatched.push(`${f.rel}: ${r.unmatched}`);
      continue;
    }
    if (r.created) {
      newCreators++;
      ctx.log(`Created creator for ${f.rel}`);
    }
    const stem = path.basename(f.rel).replace(/\.[^.]+$/, '');
    const meta = await fileMeta(f);
    // Carousel items carry their own media id in the file name, so the post shortcode groups them.
    const key = meta.shortcode ? `ig:${meta.shortcode}` : groupKey(stem);
    const gk = `${r.id}|${path.dirname(f.rel)}|${key}`;
    const g = groups.get(gk) ?? { creatorId: r.id, files: [], dir: path.dirname(f.abs), key, shortcode: meta.shortcode };
    g.files.push({ f, meta });
    groups.set(gk, g);
  }
  let posts = 0;
  let media = 0;
  let rejected = 0;
  let known = 0;
  const knownKey = db.prepare('SELECT 1 FROM posts WHERE source_key = ?');
  const sidecars = new Set<string>();
  for (const g of groups.values()) {
    if (ctx.stopped()) break;
    g.files.sort((a, b) => (a.meta.index ?? 0) - (b.meta.index ?? 0) || a.f.rel.localeCompare(b.f.rel, undefined, { numeric: true }));
    for (const { meta } of g.files) if (meta.sidecar) sidecars.add(meta.sidecar);
    const sourceKey = g.shortcode ? `ig:${g.shortcode}` : null;
    if (sourceKey && knownKey.get(sourceKey)) {
      known++;
      for (const { f } of g.files) await setAside(f.abs, DONE_DIR);
      continue;
    }
    const caption = g.files.map((x) => x.meta.caption).find(Boolean) ?? (g.shortcode ? '' : await readSidecar(g.dir, g.key, sidecars));
    const incoming: IncomingFile[] = g.files.map(({ f }) => ({ abs: f.abs, name: path.basename(f.rel) }));
    const created = dateFromName(path.basename(g.files[0].f.rel)) ?? Math.min(...g.files.map(({ f }) => f.mtime));
    const sourceUrl = g.files.map((x) => x.meta.postUrl).find(Boolean) ?? null;
    const result = await createPost({ author: { creatorId: g.creatorId }, caption, createdAt: created, sourceUrl, sourceKey, files: incoming, skipKnown: true });
    for (const r of result.rejected) {
      rejected++;
      ctx.log(`Rejected ${r.name}: ${r.reason}`);
      const x = g.files.find(({ f }) => path.basename(f.rel) === r.name);
      if (x) await setAside(x.f.abs, REJECTED_DIR);
    }
    if (result.postId) {
      posts++;
      media += result.added;
      notifyFollowers(g.creatorId, result.postId, null);
    }
  }
  for (const s of sidecars) await setAside(s, DONE_DIR);
  // Leftover JSON files that describe a profile rather than a post.
  let profiles = 0;
  for (const f of files.filter((x) => !x.young && /\.json$/i.test(x.rel) && !sidecars.has(x.abs))) {
    const j = await readJson(f.abs);
    if (j?.kind !== 'profile') continue;
    if (await applyProfile(f, j, ctx)) {
      profiles++;
      await setAside(f.abs, DONE_DIR);
    }
  }
  for (const u of unmatched.slice(0, 50)) ctx.log(`Unmatched ${u}`);
  const parts = [`${posts} posts / ${media} files imported`];
  if (newCreators) parts.push(`${newCreators} new creators`);
  if (known) parts.push(`${known} already in the library`);
  if (profiles) parts.push(`${profiles} profiles updated`);
  if (rejected) parts.push(`${rejected} rejected (moved to ${REJECTED_DIR})`);
  if (unmatched.length) parts.push(`${unmatched.length} unmatched left in place`);
  if (young) parts.push(`${young} too new, skipped`);
  return parts.join(', ');
}

export async function importStatus() {
  const files = await scanImportDir();
  return {
    dir: config.importDir,
    pending: files.filter((f) => MEDIA_EXT.test(f.rel)).map((f) => ({ name: f.rel, size: f.size, young: f.young, guess: guessCreator(f) })),
    other: files.filter((f) => !MEDIA_EXT.test(f.rel) && !SIDECAR_EXT.test(f.rel)).map((f) => f.rel),
    rejected: (await scanSub(REJECTED_DIR)).slice(0, 200),
  };
}

function guessCreator(f: PendingFile): string | null {
  const parts = f.rel.split(path.sep);
  if (parts.length > 1) return parts[0].toLowerCase();
  const stem = path.basename(f.rel).replace(/\.[^.]+$/, '').toLowerCase();
  const all = db.prepare('SELECT handle FROM creators WHERE deleted = 0 UNION ALL SELECT alias FROM creator_aliases').pluck().all() as string[];
  const hit = all.filter((n) => stem === n || (stem.startsWith(n) && /[_ .-]/.test(stem[n.length] ?? ''))).sort((a, b) => b.length - a.length)[0];
  return hit ?? handleFromFileName(stem);
}

async function scanSub(sub: string): Promise<string[]> {
  const out: PendingFile[] = [];
  await walk(path.join(config.importDir, sub), path.join(config.importDir, sub), 0, out);
  return out.map((f) => f.rel);
}
