// Run: npm run check:backup  (uses throwaway DATA_DIR and BACKUP_DIR, never the live paths)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'egram-backup-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.BACKUP_KEEP = '2';
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });

const { default: Database } = await import('better-sqlite3');
const { runBackup } = await import('../jobs/maintenance.js');
const dir = process.env.BACKUP_DIR;
const ctx = { log: (): void => undefined, stopped: (): boolean => false } as unknown as Parameters<typeof runBackup>[0];
const list = (): string[] => fs.readdirSync(dir).sort();

// Pre-existing files: an old backup with sidecars, an orphan sidecar, and unrelated files.
for (const f of ['elitogram-20200101-000000.db', 'elitogram-20200101-000000.db-shm', 'elitogram-20200101-000000.db-wal',
  'elitogram-20200102-000000.db', 'elitogram-20190101-000000.db-wal', 'manual-before-upgrade.db', 'manual-before-upgrade.db-wal', 'notes.txt']) {
  fs.writeFileSync(path.join(dir, f), 'x');
}

await runBackup(ctx);
const files = list();
const fresh = files.filter((f) => /^elitogram-(?!2019|2020)\d{8}-\d{6}\.db$/.test(f));
assert.equal(fresh.length, 1, 'new backup exists');
assert.deepEqual(files.filter((f) => f.startsWith(fresh[0])), fresh, 'backup leaves exactly one file');

const b = new Database(path.join(dir, fresh[0]), { readonly: true });
assert.equal(b.pragma('quick_check', { simple: true }), 'ok', 'backup passes quick_check');
b.close();
assert.ok(!list().some((f) => f.startsWith(fresh[0]) && f !== fresh[0]), 'no sidecars after opening the backup');

assert.ok(!files.includes('elitogram-20190101-000000.db-wal'), 'orphan sidecar removed');
assert.ok(!files.includes('elitogram-20200101-000000.db'), 'retention removed old .db');
assert.ok(!files.includes('elitogram-20200101-000000.db-shm') && !files.includes('elitogram-20200101-000000.db-wal'), 'retention removed sidecars');
assert.ok(files.includes('elitogram-20200102-000000.db'), 'newer backup kept');
for (const f of ['manual-before-upgrade.db', 'manual-before-upgrade.db-wal', 'notes.txt']) assert.ok(files.includes(f), `unrelated ${f} kept`);

fs.rmSync(root, { recursive: true, force: true });
console.log('backup checks OK');
