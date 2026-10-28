import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, now } from './db/index.js';
import { config } from './config.js';

export const PERMISSIONS = ['import', 'duplicates', 'cleaning', 'profiles', 'sources', 'jobs', 'users'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  permissions: Permission[];
  has_pin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const SESSION_COOKIE = 'eg_session';
const ADULT_COOKIE = 'eg_adult';

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, key);
}

const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

function cookieOpts(maxAgeMs: number) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}

export function startSession(res: Response, userId: number): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = config.sessionDays * 86_400_000;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now(), now() + ttl);
  res.cookie(SESSION_COOKIE, token, cookieOpts(ttl));
}

export function endSession(req: Request, res: Response): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(ADULT_COOKIE, { path: '/' });
}

export function loadUser(userId: number): SessionUser | undefined {
  const u = db.prepare('SELECT id, username, display_name, role, permissions, pin_hash, disabled FROM users WHERE id = ?').get(userId) as any;
  if (!u || u.disabled) return undefined;
  let perms: Permission[] = [];
  try {
    perms = (JSON.parse(u.permissions) as string[]).filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
  } catch {
    perms = [];
  }
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, permissions: u.role === 'admin' ? [...PERMISSIONS] : perms, has_pin: !!u.pin_hash };
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(tokenHash(token)) as { user_id: number; expires_at: number } | undefined;
    if (s && s.expires_at > now()) req.user = loadUser(s.user_id);
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export function can(user: SessionUser | undefined, perm: Permission): boolean {
  return !!user && (user.role === 'admin' || user.permissions.includes(perm));
}

export function requirePerm(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!can(req.user, perm)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

/**
 * Every state-changing request must come from the app's own origin. Browsers
 * always send Origin on cross-site POSTs; Sec-Fetch-Site is a second signal.
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const allowed = [config.appOrigin, ...config.extraOrigins];
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  let ok = false;
  if (origin) ok = allowed.includes(origin);
  else if (site) ok = site === 'same-origin';
  else {
    const ref = req.get('referer');
    ok = !!ref && allowed.some((a) => ref === a || ref.startsWith(a + '/'));
  }
  if (!ok) {
    res.status(403).json({ error: 'Cross-origin request refused' });
    return;
  }
  next();
}

// --- 18+ gate ---------------------------------------------------------------

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.adultSecret).update(payload).digest('base64url');
}

export function setAdultUnlock(res: Response, userId: number): number {
  const exp = now() + config.adultUnlockMinutes * 60_000;
  const payload = Buffer.from(JSON.stringify({ u: userId, exp })).toString('base64url');
  res.cookie(ADULT_COOKIE, `${payload}.${sign(payload)}`, cookieOpts(config.adultUnlockMinutes * 60_000));
  return exp;
}

export function clearAdultUnlock(res: Response): void {
  res.clearCookie(ADULT_COOKIE, { path: '/' });
}

/** Returns the unlock expiry when the request carries a valid 18+ cookie for its own user. */
export function adultUntil(req: Request): number | null {
  const raw = req.cookies?.[ADULT_COOKIE];
  if (!raw || !req.user) return null;
  const [payload, sig] = String(raw).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (u !== req.user.id || typeof exp !== 'number' || exp < now()) return null;
    return exp;
  } catch {
    return null;
  }
}

export const adultUnlocked = (req: Request): boolean => adultUntil(req) !== null;

/** SQL condition hiding adult posts; expects posts as `p` and creators LEFT JOINed as `c`. */
export function adultFilter(req: Request): string {
  return adultUnlocked(req) ? '1=1' : '(p.adult = 0 AND COALESCE(c.adult, 0) = 0)';
}

export function bootstrapAdmin(): void {
  const count = db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number;
  if (count > 0) return;
  if (!config.adminUsername || !config.adminPassword) {
    console.warn('No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD to create the first admin.');
    return;
  }
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)").run(
    config.adminUsername.toLowerCase(),
    config.adminUsername,
    hashPassword(config.adminPassword),
    now(),
  );
  console.log(`Created admin account "${config.adminUsername}".`);
}
