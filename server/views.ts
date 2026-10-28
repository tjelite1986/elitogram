import type { Request } from 'express';
import { db } from './db/index.js';
import { adultFilter } from './auth.js';

export const POST_FROM = `FROM posts p
  LEFT JOIN creators c ON c.id = p.creator_id
  LEFT JOIN users u ON u.id = p.user_id`;

/** Base WHERE for anything a viewer may see: not deleted, not hidden by the 18+ gate. */
export function visible(req: Request, includeDeleted = false): string {
  return `${includeDeleted ? '1=1' : 'p.deleted = 0'} AND (c.id IS NULL OR c.deleted = 0) AND ${adultFilter(req)}
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

export const POST_COLS = `p.id, p.creator_id, p.user_id, p.uploader_id, p.caption, p.created_at, p.source_url, p.adult, p.deleted,
  c.handle AS c_handle, c.display_name AS c_name, c.adult AS c_adult, u.username AS u_username, u.display_name AS u_name`;

export function mediaOf(postIds: number[]): Map<number, any[]> {
  const out = new Map<number, any[]>();
  if (postIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, post_id, kind, mime, width, height, duration FROM media WHERE missing = 0 AND post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY position, id`,
    )
    .all(...postIds) as any[];
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ id: r.id, kind: r.kind, mime: r.mime, width: r.width, height: r.height, duration: r.duration, url: `/m/${r.id}`, thumb: `/m/${r.id}/t` });
    out.set(r.post_id, list);
  }
  return out;
}

/** Full post objects for the feed and post page. */
export function hydratePosts(rows: any[], userId: number): any[] {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const media = mediaOf(ids);
  const likes = new Map((db.prepare(`SELECT post_id, COUNT(*) n FROM likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids) as any[]).map((r) => [r.post_id, r.n]));
  const comments = new Map((db.prepare(`SELECT post_id, COUNT(*) n FROM comments WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids) as any[]).map((r) => [r.post_id, r.n]));
  const mine = new Set(db.prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${ph})`).pluck().all(userId, ...ids) as number[]);
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
  }));
}

/** Compact tiles for grids: first media plus counts. */
export function gridTiles(rows: any[]): any[] {
  const media = mediaOf(rows.map((r) => r.id));
  return rows
    .map((r) => {
      const m = media.get(r.id) ?? [];
      if (m.length === 0) return null;
      return { id: r.id, media_id: m[0].id, kind: m[0].kind, thumb: m[0].thumb, count: m.length, has_video: m.some((x) => x.kind === 'video'), created_at: r.created_at };
    })
    .filter(Boolean);
}
