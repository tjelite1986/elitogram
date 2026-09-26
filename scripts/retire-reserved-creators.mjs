#!/usr/bin/env node
// Retire the junk creators whose usernames are reserved storage folder names
// ("avatars", "banners") — an old import once turned the shared avatar/banner
// stores into creators, publishing 1600+ profile pictures as library posts.
//
//   node scripts/retire-reserved-creators.mjs          # dry run, prints counts
//   node scripts/retire-reserved-creators.mjs --yes    # apply
//
// This soft-deletes their posts (is_deleted = 1) and touches NOTHING on disk:
// the files under POSTS_ROOT/avatars include every live profile picture, so
// deleting by directory is never safe there (see scripts/purge-creator.mjs,
// which refuses these names outright). A creator with zero visible posts is
// dropped from /people by the directory filter, so no creator row needs to go.
// Reversible: set is_deleted = 0 on the same rows to bring the posts back.

import Database from "better-sqlite3";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = path.join(DATA_DIR, "elitogram.db");
const RESERVED = ["avatars", "banners", "_import"];

const apply = process.argv.includes("--yes");
const log = (m) => console.log(`[retire-reserved] ${m}`);

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 30000");
db.pragma("journal_mode = WAL");

const creators = db
  .prepare(
    `SELECT id, username, source FROM post_creators
      WHERE username IN (${RESERVED.map(() => "?").join(",")})
         OR username LIKE 'u\\_%' ESCAPE '\\'`
  )
  .all(...RESERVED);

if (!creators.length) {
  log("no reserved-name creators found — nothing to do");
  db.close();
  process.exit(0);
}

let total = 0;
for (const c of creators) {
  const live = db
    .prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE author_creator_id = ? AND is_deleted = 0"
    )
    .get(c.id).n;
  log(`creator ${c.id} "${c.username}" (source=${c.source}): ${live} live post(s)`);
  total += live;
  if (apply && live) {
    const r = db
      .prepare(
        "UPDATE posts SET is_deleted = 1 WHERE author_creator_id = ? AND is_deleted = 0"
      )
      .run(c.id);
    log(`  soft-deleted ${r.changes} post(s)`);
  }
}

if (!apply) log(`dry run — pass --yes to soft-delete ${total} post(s)`);
else log("done — files untouched, rows reversible with is_deleted = 0");
db.close();
