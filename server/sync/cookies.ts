import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db/index.js';

export const cookieDir = path.join(config.dataDir, 'cookies');

export interface CookieRow {
  id: number;
  label: string;
  file: string;
  disabled: number;
  cooldown_until: number | null;
  last_used_at: number | null;
  last_error: string | null;
  created_at: number;
}

export function saveCookieFile(label: string, content: string): number {
  if (!/^# (Netscape )?HTTP Cookie File/m.test(content) && !/\tTRUE\t|\tFALSE\t/.test(content)) {
    throw new Error('Expected a Netscape-format cookies.txt export');
  }
  if (!/instagram\.com/.test(content)) throw new Error('The file has no instagram.com cookies');
  fs.mkdirSync(cookieDir, { recursive: true, mode: 0o700 });
  const file = `${crypto.randomBytes(8).toString('hex')}.txt`;
  fs.writeFileSync(path.join(cookieDir, file), content, { mode: 0o600 });
  const r = db.prepare('INSERT INTO cookies (label, file, created_at) VALUES (?, ?, ?)').run(label || 'Cookie', file, now());
  return Number(r.lastInsertRowid);
}

export function deleteCookie(id: number): void {
  const row = db.prepare('SELECT file FROM cookies WHERE id = ?').get(id) as { file: string } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM cookies WHERE id = ?').run(id);
  fs.rmSync(path.join(cookieDir, path.basename(row.file)), { force: true });
}

export function listCookies(): CookieRow[] {
  return db.prepare('SELECT * FROM cookies ORDER BY id').all() as CookieRow[];
}

/**
 * The same creator always maps to the same cookie (by a stable hash over the
 * enabled cookies). A cookie in cooldown means that creator waits, rather than
 * being fetched with a different session.
 */
export function cookieFor(handle: string): { cookie: CookieRow; path: string } | { waiting: string } | null {
  const enabled = (db.prepare('SELECT * FROM cookies WHERE disabled = 0 ORDER BY id').all() as CookieRow[]).filter((c) =>
    fs.existsSync(path.join(cookieDir, path.basename(c.file))),
  );
  if (enabled.length === 0) return null;
  let h = 0;
  for (const ch of handle.toLowerCase()) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  const cookie = enabled[h % enabled.length];
  if (cookie.cooldown_until && cookie.cooldown_until > now()) return { waiting: `cookie "${cookie.label}" is cooling down` };
  return { cookie, path: path.join(cookieDir, path.basename(cookie.file)) };
}

export function markCookie(id: number, error: string | null, cooldownHours = 0): void {
  db.prepare('UPDATE cookies SET last_used_at = ?, last_error = ?, cooldown_until = ? WHERE id = ?').run(
    now(),
    error,
    cooldownHours > 0 ? now() + cooldownHours * 3_600_000 : null,
    id,
  );
}
