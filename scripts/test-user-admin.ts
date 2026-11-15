// Run: npx tsx scripts/test-user-admin.ts  (uses a throwaway DATA_DIR)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-useradmin-'));
process.env.ADULT_COOKIE_SECRET = 'test';

const { default: express } = await import('express');
const { db, now } = await import('../server/db/index.js');
const { hashPassword, loadUser } = await import('../server/auth.js');
const { account } = await import('../server/routes/account.js');

const mk = (name: string, role: string, perms: string[]) =>
  Number(db.prepare('INSERT INTO users (username, display_name, password_hash, role, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, name, hashPassword('password123'), role, JSON.stringify(perms), now()).lastInsertRowid);

const adminId = mk('boss', 'admin', []);
const admin2 = mk('boss2', 'admin', []);
const memberId = mk('mod', 'member', ['users', 'jobs']);
const otherId = mk('plain', 'member', []);

// Test-only auth: the x-user header picks the session user.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = loadUser(Number(req.header('x-user'))); next(); });
app.use('/api', account);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/users`;

const call = async (as: number, method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': String(as) }, body: JSON.stringify(body ?? {}) });
  return r.status;
};
const perms = (id: number) => JSON.parse(db.prepare('SELECT permissions FROM users WHERE id = ?').pluck().get(id) as string) as string[];
const addSession = (uid: number) => db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(`s${uid}${Math.random()}`, uid, now(), now() + 1e6);
const sessions = (uid: number) => db.prepare('SELECT COUNT(*) FROM sessions WHERE user_id = ?').pluck().get(uid) as number;

// --- member holding 'users' ---
assert.equal(await call(memberId, 'POST', '/', { username: 'evil', password: 'password123', role: 'admin' }), 403);
assert.equal(db.prepare("SELECT 1 FROM users WHERE username = 'evil'").get(), undefined);
assert.equal(await call(memberId, 'POST', '/', { username: 'fine', password: 'password123' }), 201);
assert.equal(await call(memberId, 'PATCH', `/${admin2}`, { password: 'hacked1234' }), 403);
assert.equal(await call(memberId, 'PATCH', `/${admin2}`, { disabled: true }), 403);
assert.equal(await call(memberId, 'PATCH', `/${admin2}`, { clear_pin: true }), 403);
assert.equal(await call(memberId, 'PATCH', `/${admin2}`, { badges: [] }), 403);
assert.equal(db.prepare('SELECT disabled FROM users WHERE id = ?').pluck().get(admin2), 0);
assert.equal(await call(memberId, 'PATCH', `/${memberId}`, { permissions: ['users', 'jobs', 'import'] }), 403);
assert.deepEqual(perms(memberId), ['users', 'jobs']);
assert.equal(await call(memberId, 'PATCH', `/${otherId}`, { permissions: ['import'] }), 403); // lacks 'import'
assert.equal(await call(memberId, 'PATCH', `/${otherId}`, { permissions: ['jobs'], password: 'x' }), 400); // short password aborts all
assert.deepEqual(perms(otherId), []); // nothing half-applied
assert.equal(await call(memberId, 'PATCH', `/${otherId}`, { permissions: ['jobs'] }), 200);
assert.deepEqual(perms(otherId), ['jobs']);
assert.equal(await call(memberId, 'PATCH', `/${otherId}`, { role: 'admin' }), 403);

// --- admin can still do everything ---
assert.equal(await call(adminId, 'POST', '/', { username: 'newadmin', password: 'password123', role: 'admin' }), 201);
assert.equal(db.prepare("SELECT role FROM users WHERE username = 'newadmin'").pluck().get(), 'admin');
addSession(admin2);
assert.equal(await call(adminId, 'PATCH', `/${admin2}`, { password: 'newpass1234' }), 200);
assert.equal(sessions(admin2), 0, 'password reset must drop sessions');
assert.equal(await call(adminId, 'PATCH', `/${memberId}`, { permissions: ['users', 'jobs', 'import'] }), 200);
assert.deepEqual(perms(memberId), ['users', 'jobs', 'import']);
assert.equal(await call(adminId, 'PATCH', `/${adminId}`, { permissions: ['jobs'] }), 200);
assert.equal(await call(adminId, 'PATCH', `/${admin2}`, { disabled: true }), 200);
assert.equal(await call(adminId, 'PATCH', `/${admin2}`, { clear_pin: true }), 200);
// the last-active-admin guard still applies (newadmin remains, so disable it then boss)
assert.equal(await call(adminId, 'PATCH', `/${db.prepare("SELECT id FROM users WHERE username='newadmin'").pluck().get()}`, { disabled: true }), 200);
assert.equal(await call(adminId, 'PATCH', `/${adminId}`, { disabled: true }), 400);

server.close();
console.log('user admin tests passed');
process.exit(0);
