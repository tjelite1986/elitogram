// Run: npm run check:jobs  (uses a throwaway DATA_DIR, never the live database)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'egram-jobs-'));

const { db } = await import('../db/index.js');
const { registerJob } = await import('../jobs/scheduler.js');

const run = async (): Promise<string> => 'ok';
const register = (): void => {
  registerJob({ name: 'db_backup', title: 'b', description: 'b', defaultInterval: 1440, defaultEnabled: true, run });
  registerJob({ name: 'other', title: 'o', description: 'o', defaultInterval: 60, run });
};
const enabled = (name: string): number => db.prepare('SELECT enabled FROM jobs WHERE name = ?').pluck().get(name) as number;

register();
assert.equal(enabled('db_backup'), 1, 'new database: db_backup enabled');
assert.equal(enabled('other'), 0, 'other jobs start disabled');

db.prepare("UPDATE jobs SET enabled = 0 WHERE name = 'db_backup'").run();
register(); // simulated restart
assert.equal(enabled('db_backup'), 0, 'existing disabled row stays disabled');
assert.equal(enabled('other'), 0, 'other jobs still disabled after restart');

console.log('job defaults OK');
