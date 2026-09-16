#!/usr/bin/env node
// One-off: seed this app's database from elite-v2's, taking the whole posts
// library and the profile layer that describes it.
//
//   node scripts/migrate-from-elitev2.mjs <source.db> [dest.db]
//
// The source MUST be a snapshot taken with SQLite's .backup, not a copied file:
// elite-v2 runs in WAL mode, and a plain `cp` of the .db without its -wal is a
// file that opens fine and reports zero rows.
//
// Ids are preserved. That is the whole point — a post's media, a like's user_id,
// a duplicate group's media_id and every storage_key all reference ids that
// exist on the other side, and renumbering would mean rewriting all of them.
// The accounts come across as a mirror of elite-v2's users, keyed by the same
// integer the session already carries (lib/sso.ts), with `adult_pin_hash`
// brought along so a personal PIN keeps working on this host.
//
// Idempotent: every insert is INSERT OR IGNORE, so a re-run adds what is missing
// and touches nothing already here. It does NOT delete: a row removed in
// elite-v2 after the first run stays, because by then this app owns its library
// and a second migration is a top-up, not a mirror.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
const DEST =
  process.argv[3] ||
  path.join(process.env.DATA_DIR || "/app/data", "elitogram.db");

const log = (m) => console.log(`[migrate] ${m}`);

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: migrate-from-elitev2.mjs <source.db> [dest.db]");
  process.exit(1);
}

const db = new Database(DEST);
db.pragma("busy_timeout = 30000");
db.pragma("journal_mode = WAL");

// The destination schema is created by the app on first start. Running this
// before that has happened would build half a schema here and let the app's own
// migrate() disagree with it later, so refuse rather than guess.
const havePosts = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='posts'")
  .get();
if (!havePosts) {
  console.error(
    "The destination has no schema yet. Start the app once (it runs migrate() " +
      "on boot), then run this."
  );
  process.exit(1);
}

db.prepare("ATTACH DATABASE ? AS src").run(SRC);

// Foreign keys are enforced in the app; here the copy order is what guarantees
// them (authors before posts, posts before media), and turning the check off
// would only hide a real ordering mistake.
db.pragma("foreign_keys = ON");

// A column the source does not have must not fail the whole run: elite-v2's
// schema moves, and this script has to keep working against an older snapshot.
const srcColumns = (table) => {
  try {
    return new Set(
      db.prepare(`PRAGMA src.table_info(${table})`).all().map((r) => r.name)
    );
  } catch {
    return new Set();
  }
};
const pick = (table, column, fallback = "NULL") =>
  srcColumns(table).has(column) ? column : fallback;

const counts = {};
function copy(label, sql) {
  const info = db.prepare(sql).run();
  counts[label] = info.changes;
  log(`${label}: ${info.changes}`);
}

const tx = db.transaction(() => {
  // Accounts first: everything else references them. The mirror keeps the
  // handle from user_profiles so a name renders before the person's first visit
  // here re-verifies the session. The password hash is deliberately left behind
  // — elite-v2 owns the login. The 18+ PIN hash is not: it gates surfaces on
  // this host, so it has to be checkable here.
  copy(
    "users",
    `INSERT OR IGNORE INTO main.users (id, email, role, username, display_name, adult_pin_hash, created_at)
     SELECT u.id, u.email, u.role, p.username, p.display_name,
            ${pick("users", "adult_pin_hash")}, u.created_at
       FROM src.users u
       LEFT JOIN src.user_profiles p ON p.user_id = u.id`
  );

  copy(
    "user_profiles",
    `INSERT OR IGNORE INTO main.user_profiles
       (user_id, username, display_name, avatar_key, bio, show_adult_outside, created_at)
     SELECT user_id, username, display_name, avatar_key, bio,
            ${pick("user_profiles", "show_adult_outside", "0")}, created_at
       FROM src.user_profiles`
  );

  copy(
    "post_creators",
    `INSERT OR IGNORE INTO main.post_creators
       (id, username, display_name, avatar_key, bio, source, is_adult, created_at)
     SELECT id, username, display_name, avatar_key, bio, source, is_adult, created_at
       FROM src.post_creators`
  );

  copy(
    "posts",
    `INSERT OR IGNORE INTO main.posts
       (id, author_user_id, author_creator_id, caption, is_adult, created_at, is_deleted)
     SELECT id, author_user_id, author_creator_id, caption, is_adult, created_at, is_deleted
       FROM src.posts`
  );

  copy(
    "post_media",
    `INSERT OR IGNORE INTO main.post_media
       (id, post_id, storage_key, mime_type, width, height, position, media_version, content_hash)
     SELECT id, post_id, storage_key, mime_type, width, height, position, media_version,
            ${pick("post_media", "content_hash")}
       FROM src.post_media`
  );

  copy(
    "post_hashtags",
    `INSERT OR IGNORE INTO main.post_hashtags (post_id, tag)
     SELECT post_id, tag FROM src.post_hashtags`
  );

  copy(
    "post_likes",
    `INSERT OR IGNORE INTO main.post_likes (post_id, user_id, created_at)
     SELECT post_id, user_id, created_at FROM src.post_likes`
  );

  copy(
    "post_comments",
    `INSERT OR IGNORE INTO main.post_comments (id, post_id, user_id, body, created_at)
     SELECT id, post_id, user_id, body, created_at FROM src.post_comments`
  );

  // The follows CHECK here accepts 'shorts' so an old row stays valid, but a
  // clip library is not something this app can resolve — those rows would be
  // followers of nothing. Only user and creator targets come across.
  copy(
    "follows",
    `INSERT OR IGNORE INTO main.follows (follower_id, target_type, target_id, created_at)
     SELECT follower_id, target_type, target_id, created_at
       FROM src.follows
      WHERE target_type IN ('user','creator')`
  );

  copy(
    "stories",
    `INSERT OR IGNORE INTO main.stories
       (id, author_user_id, storage_key, mime_type, media_version, created_at, expires_at)
     SELECT id, author_user_id, storage_key, mime_type, media_version, created_at, expires_at
       FROM src.stories`
  );

  copy(
    "story_views",
    `INSERT OR IGNORE INTO main.story_views (story_id, user_id, viewed_at)
     SELECT story_id, user_id, viewed_at FROM src.story_views`
  );

  // Activity history. Only the rows this app can render: a notification about
  // something in another library would link nowhere.
  copy(
    "notifications",
    `INSERT OR IGNORE INTO main.notifications
       (id, user_id, type, actor_user_id, post_id, comment_id, message, href, created_at, read_at)
     SELECT id, user_id, type, actor_user_id, post_id, comment_id, message, href, created_at, read_at
       FROM src.notifications
      WHERE type IN ('like','comment','follow','mention')`
  );

  copy(
    "handle_avatars",
    `INSERT OR IGNORE INTO main.handle_avatars (handle, avatar_key, updated_at)
     SELECT handle, avatar_key, updated_at FROM src.handle_avatars`
  );

  copy(
    "profile_links",
    `INSERT OR IGNORE INTO main.profile_links (member_handle, primary_handle, created_at)
     SELECT member_handle, primary_handle, created_at FROM src.profile_links`
  );

  copy(
    "profile_extras",
    `INSERT OR IGNORE INTO main.profile_extras
       (handle, bio, links_json, fields_json, location, banner_key,
        instagram_handle, ig_auto_poll, ig_stories, ig_highlights,
        ig_last_synced_at, ig_last_sync_error, ig_syncing,
        tiktok_handle, tt_auto_poll, tt_last_synced_at, tt_last_sync_error, tt_syncing,
        updated_at)
     SELECT handle, bio, links_json,
            ${pick("profile_extras", "fields_json")},
            ${pick("profile_extras", "location")},
            banner_key,
            instagram_handle, ig_auto_poll,
            ${pick("profile_extras", "ig_stories", "0")},
            ${pick("profile_extras", "ig_highlights", "0")},
            ig_last_synced_at, ig_last_sync_error,
            0,
            ${pick("profile_extras", "tiktok_handle")},
            ${pick("profile_extras", "tt_auto_poll", "0")},
            ${pick("profile_extras", "tt_last_synced_at")},
            ${pick("profile_extras", "tt_last_sync_error")},
            0,
            updated_at
       FROM src.profile_extras`
  );

  // The fingerprint cache. Not data, strictly — the scanner rebuilds it — but
  // it is 45 000 rows of hashing that would otherwise be redone on the first
  // scan here, and every row is keyed by a media_id that just came across.
  copy(
    "post_media_fp",
    `INSERT OR IGNORE INTO main.post_media_fp (media_id, size_bytes, sha, sig, updated_at)
     SELECT media_id, size_bytes, sha, sig, updated_at FROM src.post_media_fp`
  );

  // Pairs an admin has already ruled on. Losing these would re-surface every
  // false positive that was dismissed once.
  copy(
    "post_dupe_ignored",
    `INSERT OR IGNORE INTO main.post_dupe_ignored (a_media_id, b_media_id, created_at)
     SELECT a_media_id, b_media_id, created_at FROM src.post_dupe_ignored`
  );
});

tx();

// The caption index is a content-table FTS5 index keyed by posts.rowid. Rows
// inserted by this script bypass the triggers (they fire on the app's writes,
// and the table was empty when they were created), so it has to be built once.
try {
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");
  const n = db.prepare("SELECT count(*) AS c FROM posts_fts").get().c;
  log(`posts_fts: rebuilt over ${n} rows`);
} catch (err) {
  log(`posts_fts: not rebuilt (${err.message}) — search falls back to LIKE`);
}

db.prepare("DETACH DATABASE src").run();
db.close();

log("done");
log(
  Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
);
