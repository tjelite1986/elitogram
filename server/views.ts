import type { Request } from 'express';
import { db } from './db/index.js';
import { adultFilter, adultUnlocked } from './auth.js';
import { creatorScopeSql, effectiveAudience, scopeOf, scopeSql } from './audience.js';

export const POST_FROM = `FROM posts p
  LEFT JOIN creators c ON c.id = p.creator_id
  LEFT JOIN users u ON u.id = p.user_id`;

/** Base WHERE for anything a viewer may see: not deleted, not hidden by the 18+ gate. */
export function visible(req: Request, includeDeleted = false): string {
  return `${includeDeleted ? '1=1' : 'p.deleted = 0'} AND (c.id IS NULL OR c.deleted = 0) AND ${adultFilter(req)} AND ${scopeSql(scopeOf(req))}
    AND EXISTS (SELECT 1 FROM media mx WHERE mx.post_id = p.id AND mx.missing = 0)`;
}

export interface Cursor {
  t: number;
  id: number;
}

export function parseCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)_(\d+)$/.exec(raw);
  return m ? { t: Number(m[1]), id: Number(m[2]) } : null;
}

export function cursorSql(c: Cursor | null, col = 'p.created_at', idCol = 'p.id'): { sql: string; args: number[] } {
  if (!c) return { sql: '1=1', args: [] };
  return { sql: `(${col} < ? OR (${col} = ? AND ${idCol} < ?))`, args: [c.t, c.t, c.id] };
}

export const nextCursor = (rows: { created_at: number; id: number }[], limit: number): string | null =>
  rows.length === limit ? `${rows[rows.length - 1].created_at}_${rows[rows.length - 1].id}` : null;

export function authorOf(row: any) {
  if (row.creator_id) {
    return { type: 'creator' as const, id: row.creator_id, handle: row.c_handle, name: row.c_name || row.c_handle, avatar: `/m/ca/${row.creator_id}`, adult: !!row.c_adult };
  }
  return { type: 'user' as const, id: row.user_id, handle: row.u_username, name: row.u_name || row.u_username, avatar: `/m/ua/${row.user_id}`, adult: false };
}

export const POST_COLS = `p.id, p.creator_id, p.user_id, p.uploader_id, p.caption, p.created_at, p.imported_at, p.source_url, p.adult, p.deleted, p.audience, p.meta, c.audience AS c_audience,
  c.handle AS c_handle, c.display_name AS c_name, c.adult AS c_adult, u.username AS u_username, u.display_name AS u_name`;

export function mediaOf(postIds: number[]): Map<number, any[]> {
  const out = new Map<number, any[]>();
  if (postIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, post_id, kind, mime, width, height, duration, size FROM media WHERE missing = 0 AND post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY position, id`,
    )
    .all(...postIds) as any[];
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ id: r.id, kind: r.kind, mime: r.mime, width: r.width, height: r.height, duration: r.duration, size: r.size, url: `/m/${r.id}`, thumb: `/m/${r.id}/t` });
    out.set(r.post_id, list);
  }
  return out;
}

/** Full post objects for the feed and post page. */
/**
 * SQL condition: may creator `c` be shown as a mention target to this request?
 * Never a deleted creator, and never an 18+ one where 18+ is locked. In a
 * scope it must also have no 18+ post at all, and be a profile the scope can
 * open: in general, any such creator mentioned by a post the scope shows
 * (loadCreator gives it a limited profile); in unknown, a creator not
 * classified general.
 */
export function mentionTargetSql(req: Request, alias = 'c'): string {
  const scope = scopeOf(req);
  const parts = [`${alias}.deleted = 0`];
  if (scope || !adultUnlocked(req)) parts.push(`${alias}.adult = 0`);
  if (scope) {
    parts.push(`NOT EXISTS (SELECT 1 FROM posts pa WHERE pa.creator_id = ${alias}.id AND pa.adult = 1)`);
    if (scope === 'unknown') parts.push(creatorScopeSql(scope, alias));
  }
  return parts.join(' AND ');
}

/** The creators each post mentions that this request may open, as written in the caption. */
function mentionsOf(postIds: number[], req: Request | undefined): Map<number, { type: 'creator'; handle: string; name: string }[]> {
  const out = new Map<number, { type: 'creator'; handle: string; name: string }[]>();
  if (!req || postIds.length === 0) return out;
  const ph = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT pm.post_id, pm.name, c.handle FROM post_mentions pm JOIN creators c ON c.id = pm.creator_id WHERE pm.post_id IN (${ph}) AND ${mentionTargetSql(req)} ORDER BY pm.post_id, pm.name`)
    .all(...postIds) as { post_id: number; name: string; handle: string }[];
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ type: 'creator', handle: r.handle, name: r.name });
    out.set(r.post_id, list);
  }
  return out;
}

export function hydratePosts(rows: any[], userId: number, req?: Request): any[] {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const media = mediaOf(ids);
  const likes = new Map((db.prepare(`SELECT post_id, COUNT(*) n FROM likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids) as any[]).map((r) => [r.post_id, r.n]));
  const comments = new Map((db.prepare(`SELECT post_id, COUNT(*) n FROM comments WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids) as any[]).map((r) => [r.post_id, r.n]));
  const mine = new Set(db.prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${ph})`).pluck().all(userId, ...ids) as number[]);
  const faves = new Set(db.prepare(`SELECT post_id FROM favorites WHERE user_id = ? AND post_id IN (${ph})`).pluck().all(userId, ...ids) as number[]);
  const mentions = mentionsOf(ids, req);
  return rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    created_at: r.created_at,
    source_url: r.source_url,
    adult: !!r.adult || !!r.c_adult,
    deleted: !!r.deleted,
    uploader_id: r.uploader_id,
    author: authorOf(r),
    media: media.get(r.id) ?? [],
    like_count: likes.get(r.id) ?? 0,
    comment_count: comments.get(r.id) ?? 0,
    liked: mine.has(r.id),
    favorited: faves.has(r.id),
    audience: effectiveAudience(r),
    imported_at: r.imported_at,
    meta: parseMeta(r.meta),
    // Creators the caption mentions (@name) that this request may open.
    mentions: mentions.get(r.id) ?? [],
  }));
}

/** Grabbit's delivery metadata (platform, original tags, download date); null when absent or unreadable. */
export function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Author and audience of each post, for grid tiles. */
function tileFacts(ids: number[]): Map<number, any> {
  const out = new Map<number, any>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT p.id, p.adult, p.audience, p.creator_id, c.adult AS c_adult, c.audience AS c_audience, c.handle AS c_handle, u.username AS u_username
       ${POST_FROM} WHERE p.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as any[];
  for (const r of rows) out.set(r.id, { audience: effectiveAudience(r), creator_id: r.creator_id ?? null, author_handle: r.c_handle ?? r.u_username ?? null, author_type: r.creator_id ? 'creator' : 'user' });
  return out;
}

/** Compact tiles for grids: first media plus counts, author and audience. */
export function gridTiles(rows: any[]): any[] {
  const ids = rows.map((r) => r.id);
  const media = mediaOf(ids);
  const facts = tileFacts(ids);
  return rows
    .map((r) => {
      const m = media.get(r.id) ?? [];
      if (m.length === 0) return null;
      const f = facts.get(r.id) ?? { audience: 'unknown', creator_id: null, author_handle: null, author_type: 'user' };
      return {
        id: r.id, media_id: m[0].id, kind: m[0].kind, thumb: m[0].thumb, width: m[0].width, height: m[0].height,
        count: m.length, has_video: m.some((x) => x.kind === 'video'), created_at: r.created_at, ...f,
      };
    })
    .filter(Boolean);
}
