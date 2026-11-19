// Mentions and hashtags backfill from the command line (Grabbit 3.0.3).
//   node dist/server/scripts/metadata-backfill.js            dry run: reads only, prints what applying would write
//   node dist/server/scripts/metadata-backfill.js --apply    applies in resumable batches, like the metadata_backfill job
// DATA_DIR picks the database, as for the server. A dry run is safe on the live database.
// A dry run is one pass in id order; an apply adds reconciliation passes when a
// pass made creators (see metadataBackfillApplyBatch), which a dry run cannot forecast.
import { db } from '../db/index.js';
import { BACKFILL_CURSOR_KEY, BackfillStopped, emptyBackfillStats, metadataBackfillApply, metadataBackfillDryBatch, type BackfillPassReport } from '../library.js';

const apply = process.argv.includes('--apply');
const batch = 200;
const started = Date.now();
const mentionCreators = () => db.prepare("SELECT COUNT(*) FROM creators WHERE origin = 'mention'").pluck().get();

if (!apply) {
  const stats = emptyBackfillStats();
  const seen = { names: new Set<string>(), tags: new Set<string>(), reused: new Set<number>() };
  console.log(`DRY RUN: ${db.prepare('SELECT COUNT(*) FROM posts WHERE deleted = 0').pluck().get()} posts (one pass)`);
  let after = 0;
  while (metadataBackfillDryBatch(after, batch, stats, seen) > 0) after = stats.lastId;
  console.log(JSON.stringify({ mode: 'dry-run', ...stats, mentionCreatorsInDb: mentionCreators(), seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} else {
  const after = Number(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(BACKFILL_CURSOR_KEY) ?? 0) || 0;
  console.log(`APPLY: continuing after post id ${after}`);
  let stopped: string | null = null;
  let run: { passes: BackfillPassReport[]; done: boolean; capped: boolean } = { passes: [], done: false, capped: false };
  try {
    run = await metadataBackfillApply({ batch, pause: () => new Promise((r) => setTimeout(r, 150)), log: (m) => console.log(`  ${m}`) });
  } catch (err) {
    if (!(err instanceof BackfillStopped)) throw err;
    stopped = err.message;
  }
  const total = (k: 'newCreators' | 'newRelations' | 'removedRelations' | 'scanned') => run.passes.reduce((n, p) => n + p.stats[k], 0);
  console.log(
    JSON.stringify(
      {
        mode: 'apply',
        passes: run.passes.map((p) => ({ pass: p.pass, ...p.stats })),
        totals: { scanned: total('scanned'), newCreators: total('newCreators'), newRelations: total('newRelations'), removedRelations: total('removedRelations') },
        capped: run.capped,
        mentionCreatorsInDb: mentionCreators(),
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
  );
  if (stopped) {
    console.error(stopped);
    process.exitCode = 1;
  }
}
