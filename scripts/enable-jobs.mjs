// One-shot: turn on the nine background jobs that ship disabled, then spread
// the ones that would otherwise fire in the same tick.
//
// The jobs are seeded with enabled = 0 so that migrating the library from
// elite-v2 could not race a running import. Once the migration is topped up,
// run this inside the container:
//
//   docker exec -w /app elitogram node /app/scripts/enable-jobs.mjs
//
// Enabling goes through setJobConfig(), the same call the admin panel makes, so
// each job's first run is deferred by a full interval instead of firing the
// moment the flag flips. But setJobConfig computes next_run_at as
// `now + interval_seconds`, so jobs sharing an interval all land on the same
// second: the three hourly jobs collide, the three daily ones collide, and the
// two syncs collide. On a Pi that means a VACUUM INTO, a full duplicate scan
// and an avatar backfill starting together.
//
// So after enabling, each interval group is fanned out by SPREAD_SECONDS. This
// only has to be done once: runJobNow() reschedules from the moment a run
// FINISHES rather than from a fixed phase, so the offsets persist through every
// later cycle.
//
// Re-running the script is a no-op. Already-enabled jobs are skipped, and a
// group is only rewritten when two of its members still sit closer together
// than the step — which is false once they have been spread.

import path from "node:path";
import Database from "/app/node_modules/better-sqlite3/lib/index.js";

const SPREAD_SECONDS = 300; // target gap between members of an interval group

const { listJobs, setJobConfig } = await import("/app/lib/jobs-runtime.mjs");

// Mirrors lib/jobs-runtime.mjs so both processes open the same file.
const DATA_DIR =
  process.env.DATA_DIR || path.resolve(import.meta.dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "elitogram.db");

const before = listJobs();
console.log(
  `before: ${before.filter((j) => j.enabled).length}/${before.length} enabled`,
);

for (const job of before) {
  if (job.enabled) {
    console.log(`  skip ${job.id} (already on)`);
    continue;
  }
  setJobConfig(job.id, { enabled: true });
  console.log(`  on   ${job.id} (every ${job.interval_seconds}s)`);
}

// --- spread ---------------------------------------------------------------
// Grouped by interval rather than by an identical timestamp: datetime('now')
// only has second resolution, so a loop that straddles a second boundary would
// otherwise leave two colliding jobs one second apart and look already spread.

const db = new Database(DB_PATH);
const rows = db
  .prepare(
    "SELECT id, interval_seconds, next_run_at, CAST(strftime('%s', next_run_at) AS INTEGER) AS next_epoch" +
      " FROM job_schedules WHERE enabled = 1 AND running = 0 AND next_run_at IS NOT NULL" +
      " ORDER BY next_epoch, id",
  )
  .all();
const setNext = db.prepare(
  "UPDATE job_schedules SET next_run_at = datetime(?, 'unixepoch'), updated_at = datetime('now')" +
    " WHERE id = ? AND running = 0",
);

const groups = new Map();
for (const row of rows) {
  if (!groups.has(row.interval_seconds)) groups.set(row.interval_seconds, []);
  groups.get(row.interval_seconds).push(row);
}

for (const [interval, members] of groups) {
  if (members.length < 2) continue;
  // Never push a job past half its own interval, however many share the slot.
  const step = Math.min(
    SPREAD_SECONDS,
    Math.floor(interval / 2 / (members.length - 1)),
  );
  const tightest = Math.min(
    ...members.slice(1).map((m, i) => m.next_epoch - members[i].next_epoch),
  );
  if (tightest >= step) {
    console.log(
      `spread: ${members.length} jobs every ${interval}s already ${tightest}s apart, leaving alone`,
    );
    continue;
  }
  const base = members[0].next_epoch;
  console.log(
    `spread: ${members.length} jobs every ${interval}s, ${tightest}s apart -> ${step}s apart`,
  );
  members.forEach((row, i) => {
    const res = setNext.run(base + step * i, row.id);
    console.log(
      `  ${res.changes ? "+" : "!"}${step * i}s ${row.id}${res.changes ? "" : " (started running, left alone)"}`,
    );
  });
}
db.close();

// Read back through the runtime's own handle, so this reports the state the
// scheduler will actually see rather than the state this script intended.
console.log("---");
const after = listJobs();
console.log(
  `after:  ${after.filter((j) => j.enabled).length}/${after.length} enabled`,
);
for (const job of [...after].sort((a, b) =>
  String(a.next_run_at).localeCompare(String(b.next_run_at)),
)) {
  console.log(
    `  ${job.enabled ? "ON " : "off"} ${job.id.padEnd(26)} every ${String(job.interval_seconds).padStart(5)}s  next ${job.next_run_at ?? "-"} UTC`,
  );
}
