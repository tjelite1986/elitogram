// Mentions and hashtags backfill from the command line (Grabbit 3.0.3).
//   node dist/server/scripts/metadata-backfill.js            dry run: reads only, prints what applying would write
//   node dist/server/scripts/metadata-backfill.js --apply    applies in resumable batches, like the metadata_backfill job
// DATA_DIR picks the database, as for the server. A dry run is safe on the live database.
import { db } from '../db/index.js';
import { BACKFILL_CURSOR_KEY, emptyBackfillStats, metadataBackfillBatch } from '../library.js';

const apply = process.argv.includes('--apply');
const batch = 200;
const stats = emptyBackfillStats();
const seen = { names: new Set<string>(), tags: new Set<string>(), reused: new Set<number>() };
const get = db.prepare('SELECT value FROM settings WHERE key = ?').pluck();
const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
// A dry run always reads everything; an apply continues where the last one stopped.
let after = apply ? Number(get.get(BACKFILL_CURSOR_KEY) ?? 0) || 0 : 0;
const total = db.prepare('SELECT COUNT(*) FROM posts WHERE deleted = 0 AND id > ?').pluck().get(after) as number;
const started = Date.now();
console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${total} posts after id ${after}`);
for (let i = 1; ; i++) {
  const n = metadataBackfillBatch(after, batch, apply, stats, seen);
  if (n === 0) break;
  after = stats.lastId;
  if (apply) {
    put.run(BACKFILL_CURSOR_KEY, String(after));
    await new Promise((r) => setTimeout(r, 150));
  }
  if (i % 25 === 0) console.log(`  ${stats.scanned} of ${total}`);
}
const creatorsByOrigin = db.prepare("SELECT COUNT(*) FROM creators WHERE origin = 'mention'").pluck().get();
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...stats, mentionCreatorsInDb: creatorsByOrigin, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
