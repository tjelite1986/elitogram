import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrations } from './schema.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Each step reads user_version inside its own IMMEDIATE transaction, so two
// processes starting at once cannot both run the same migration.
function migrate(): void {
  const step = db.transaction((): boolean => {
    const current = db.pragma('user_version', { simple: true }) as number;
    if (current >= migrations.length) return false;
    db.exec(migrations[current]);
    db.pragma(`user_version = ${current + 1}`);
    return true;
  });
  while (step.immediate()) {
    /* next migration */
  }
}
migrate();

export const now = (): number => Date.now();

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
