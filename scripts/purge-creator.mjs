#!/usr/bin/env node
// Purge one imported creator: its posts, their rows in every dependent table,
// its media directory, and finally the creator and profile rows themselves.
// Runs INSIDE the container (docker exec) so it shares the app's DB and the
// /posts-store mount.
//
//   node scripts/purge-creator.mjs <username>          # dry run, prints counts
//   node scripts/purge-creator.mjs <username> --yes    # apply
//
// The rest of the app never hard-deletes a post (see purgeEmptyPosts in
// lib/posts-maintenance.ts: is_deleted = 1, never a row delete). This script is
// the exception, because a creator row cannot go away while posts still point
// at it — soft-deleting them would leave the profile listed with an empty grid.
// Take a backup first: scripts/backup-db.mjs.
//
// PURGE_ARCHIVE_DIR moves the media directory there instead of deleting it.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = path.join(DATA_DIR, "elitogram.db");
const POSTS_ROOT = process.env.POSTS_ROOT || "/posts-store";
const ARCHIVE_DIR = process.env.PURGE_ARCHIVE_DIR || "";

const args = process.argv.slice(2);
const apply = args.includes("--yes");
const username = args.find((a) => !a.startsWith("--"));

const log = (m) => console.log(`[purge-creator] ${m}`);
const die = (m) => {
  console.error(`[purge-creator] ${m}`);
  process.exit(1);
};

if (!username) die("usage: purge-creator.mjs <username> [--yes]");

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 30000");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const creator = db
  .prepare("SELECT id, username, display_name, source FROM post_creators WHERE username = ?")
  .get(username);
if (!creator) die(`no creator named ${username}`);

const postIds = db
  .prepare("SELECT id FROM posts WHERE author_creator_id = ?")
  .all(creator.id)
  .map((r) => r.id);
const media = db
  .prepare(
    `SELECT m.id, m.storage_key FROM post_media m
       JOIN posts p ON p.id = m.post_id
      WHERE p.author_creator_id = ?`
  )
  .all(creator.id);

const prefix = `${username}/`;
// Two ways this purge could take someone else's data with it: a post of this
// creator storing media under another profile's directory, or another creator's
// post storing media under this one's. Either means the directory is shared and
// removing it wholesale is wrong, so refuse instead of guessing.
const strayKeys = media.filter((m) => !m.storage_key.startsWith(prefix));
if (strayKeys.length) {
  die(
    `${strayKeys.length} media key(s) of ${username} live outside ${prefix}, ` +
      `e.g. ${strayKeys[0].storage_key} — refusing to purge`
  );
}
const foreign = db
  .prepare(
    `SELECT COUNT(*) AS n FROM post_media m
       JOIN posts p ON p.id = m.post_id
      WHERE m.storage_key LIKE ? AND p.author_creator_id IS NOT ?`
  )
  .get(`${prefix}%`, creator.id).n;
if (foreign) die(`${foreign} media row(s) under ${prefix} belong to another author — refusing to purge`);

const mediaDir = path.join(POSTS_ROOT, username);
const onDisk = fs.existsSync(mediaDir)
  ? fs.readdirSync(mediaDir, { withFileTypes: true }).filter((e) => e.isFile()).length
  : 0;

log(`creator ${creator.id} ${creator.username} (source=${creator.source})`);
log(`posts: ${postIds.length}, media rows: ${media.length}, files in ${mediaDir}: ${onDisk}`);
if (!apply) {
  log("dry run — pass --yes to apply");
  db.close();
  process.exit(0);
}

const counts = {};
const run = (label, sql, params) => {
  counts[label] = (counts[label] || 0) + db.prepare(sql).run(...params).changes;
};

const purge = db.transaction(() => {
  for (const id of postIds) {
    run("post_dupe_groups", "DELETE FROM post_dupe_groups WHERE post_id = ?", [id]);
    run("post_hashtags", "DELETE FROM post_hashtags WHERE post_id = ?", [id]);
    run("post_likes", "DELETE FROM post_likes WHERE post_id = ?", [id]);
    run("post_comments", "DELETE FROM post_comments WHERE post_id = ?", [id]);
    run("notifications", "DELETE FROM notifications WHERE post_id = ?", [id]);
  }
  for (const m of media) {
    run("post_media_fp", "DELETE FROM post_media_fp WHERE media_id = ?", [m.id]);
    run("post_dupe_ignored", "DELETE FROM post_dupe_ignored WHERE a_media_id = ? OR b_media_id = ?", [m.id, m.id]);
    run("post_media", "DELETE FROM post_media WHERE id = ?", [m.id]);
  }
  // The posts_ad trigger drops each caption from posts_fts.
  for (const id of postIds) run("posts", "DELETE FROM posts WHERE id = ?", [id]);
  run("follows", "DELETE FROM follows WHERE target_type = 'creator' AND target_id = ?", [creator.id]);
  run("profile_extras", "DELETE FROM profile_extras WHERE handle = ?", [username]);
  run("profile_links", "DELETE FROM profile_links WHERE member_handle = ? OR primary_handle = ?", [username, username]);
  run("handle_avatars", "DELETE FROM handle_avatars WHERE handle = ?", [username]);
  run("post_creators", "DELETE FROM post_creators WHERE id = ?", [creator.id]);
});
purge();
db.close();

for (const [table, n] of Object.entries(counts)) log(`  ${table}: ${n} row(s)`);

// After the commit, like cleanup-stories.mjs: a rollback with the files already
// gone is unrecoverable, while the other order can only orphan files.
if (fs.existsSync(mediaDir)) {
  if (ARCHIVE_DIR) {
    const dest = path.join(ARCHIVE_DIR, username);
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    if (fs.existsSync(dest)) die(`archive destination ${dest} already exists — moving nothing`);
    fs.cpSync(mediaDir, dest, { recursive: true });
    fs.rmSync(mediaDir, { recursive: true, force: true });
    log(`archived ${onDisk} file(s) to ${dest}`);
  } else {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    log(`removed ${onDisk} file(s) in ${mediaDir}`);
  }
}
log(`purged ${username}`);
